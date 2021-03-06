// Sonos speakers: http://www.sonos.com/system

var sonos       = require('sonos')
  , stringify   = require('json-stringify-safe')
  , url         = require('url')
  , util        = require('util')
  , validator   = require('validator')
  , xml2js      = require('xml2js')
  , devices     = require('./../../core/device')
  , steward     = require('./../../core/steward')
  , utility     = require('./../../core/utility')
  , discovery   = require('./../../discovery/discovery-ssdp')
  , media       = require('./../device-media')
  ;


var logger = media.logger;

var Sonos_Audio = exports.Device = function(deviceID, deviceUID, info) {
  var o, self;

  self = this;

  self.whatami = info.deviceType;
  self.deviceID = deviceID.toString();
  self.deviceUID = deviceUID;
  self.name = info.device.name;
  self.getName();

  self.url = info.url;
  self.sid = null;
  self.seq = 0;

  o = url.parse(info.url);
  self.sonos = new sonos.Sonos(o.hostname, o.port);
  self.status = 'idle';
  self.changed();
  self.info = { track: {}, mode: 'normal' };
  self.refreshID = null;

  self.sonos.getZoneAttrs(function(err, attrs) {
    if (err) return self.error(self, err,  'getZoneAttrs');

    self.setName(attrs.CurrentZoneName);
  });

  utility.broker.subscribe('actors', function(request, taskID, actor, perform, parameter) {
    if (actor !== ('device/' + self.deviceID)) return;

    if (request === 'perform') return self.perform(self, taskID, perform, parameter);
  });

  utility.broker.subscribe('discovery', function(method, headers, content) {
    if (method === 'notify') self.notify(self, headers, content);
  });

// we poll because '/MediaRenderer/RenderingControl/Event' dosen't inform us of changes in volume/mutedness
  self.refresh(self);

  self.jumpstart(self, '/MediaRenderer/AVTransport/Event');
};
util.inherits(Sonos_Audio, media.Device);


Sonos_Audio.prototype.jumpstart = function(self, path) {
  discovery.upnp_subscribe('device/' + self.deviceID, self.url, self.sid, path, function(err, state, response) {
    var i, secs;

    logger.debug('subscribe: ' + state + ' code ' + response.statusCode,
                      { err: stringify(err), headers: stringify(response.headers) });
    if (err) {
      self.error(self, err, 'subscribe');
      setTimeout(function() { self.jumpstart(self, path); }, secs * 30 * 1000);
      return;
    }

    if ((response.statusCode !== 200) || (!response.headers.sid)) {
      self.sid = null;
      setTimeout(function() { self.jumpstart(self, path); }, secs * 30 * 1000);
      return;
    }

    self.sid = response.headers.sid;
    self.seq = 0;
    if (!!response.headers.timeout) {
      secs = response.headers.timeout;
      if ((i = secs.indexOf('Second-')) >= 0) secs = secs.substring(i + 7);
      secs = parseInt(secs, 10) - 1;
      if (secs <= 10) secs = 10;
      setTimeout(function() { self.jumpstart(self, path); }, secs * 1000);
    } else secs = 0;

    logger.info('device/' + self.deviceID, { subscribe: self.sid, path: path, sequence: self.seq, seconds: secs });
  });
};

Sonos_Audio.prototype.perform = function(self, taskID, perform, parameter) {
  var e, param0, params;

  try { params = JSON.parse(parameter); } catch(ex) { params = {}; }

  e = perform;
  param0 = null;
  switch (perform) {
    case 'set':
      if (!!params.name) {
        self.sonos.setName(params.name, function(err, data) {/* jshint unused: false */
          if (err) return self.error(self, err,  'setName');

          self.setName(params.name);
        });
      }
      if (!!params.mode) {
        param0 = { normal   : 'NORMAL'
                 , repeat   : 'REPEAT_ALL'
                 , shuffle  : 'SHUFFLE'
                 , shuffle1 : 'SHUFFLE_NOREPEAT'
                 }[params.mode.toLowerCase()];
        self.sonos.setPlayMode(param0, function(err, data) {/* jshint unused: false */
          if (err) return self.error(self, err,  'setPlayMode');
        });
      }
      if (!!params.position) {
        self.sonos.seek(Math.round(params.position / 1000), function(err, data) {/* jshint unused: false */
          if (err) return self.error(self, err,  'seek');
        });
      }
      if (!!params.volume) {
        self.sonos.setVolume(params.volume, function(err, data) {/* jshint unused: false */
          if (err) return self.error(self, err,  'setVolume');
        });
      }
      if (!!params.muted) {
        self.sonos.setMuted(params.muted === 'on' ? '1' : '0', function(err, data) {/* jshint unused: false */
          if (err) return self.error(self, err,  'setMuted');
        });
      }
      return true;

    case 'play':
      param0 = (!!params.url) && (params.url.length) ? params.url : null;
      break;

    case 'queueNext':
      if (!params.url) return false;
      param0 = params.url;
      break;

    case 'stop':
    case 'pause':
    case 'next':
    case 'previous':
    case 'flush':
      break;

    default:
      return false;
  }

  if (!!param0) {
    self.sonos[e](param0, function(err, data) {/* jshint unused: false */
      if (err) self.error(self, err, e);
    });
  } else {
    self.sonos[e](function(err, data) {/* jshint unused: false */
      if (err) self.error(self, err, e);
    });
  }

  return steward.performed(taskID);
};

Sonos_Audio.prototype.notify = function(self, headers, content) {
  var parser = new xml2js.Parser();

  if ((headers.sid !== self.sid) || (headers.seq < self.seq)) return;
  self.seq = headers.seq + 1;

  try { parser.parseString(content, function(err, data) {
    if (err) {
      logger.error('device/' + self.deviceID, { event: 'xml2js.Parser', content: content, diagnostic: err.message });
      return;
    }

    if ((!data['e:propertyset'])
          || (!util.isArray(data['e:propertyset']['e:property']))
          || (!util.isArray(data['e:propertyset']['e:property'][0].LastChange))) return;

    parser.parseString(data['e:propertyset']['e:property'][0].LastChange[0], function(err, event) {
      var mode, status;

      if (err) {
        logger.error('device/' + self.deviceID,
                          { event      : 'xml2js.Parser'
                          , diagnostic : 'parseString'
                          , content    : data['e:propertyset']['e:property'][0].LastChange[0]
                          , exception  : err });
        return;
      }

      status = { PLAYING          : 'playing'
               , PAUSED_PLAYBACK  : 'paused'
               , TRANSITIONING    : 'busy'
               , STOPPED          : 'idle'
               }[event.Event.InstanceID[0].TransportState[0].$.val] || 'idle';
      mode   = { NORMAL           : 'normal'
               , REPEAT_ALL       : 'repeat'
               , SHUFFLE          : 'shuffle'
               , SHUFFLE_NOREPEAT : 'shuffle1'
               }[event.Event.InstanceID[0].CurrentPlayMode[0].$.val] || 'normal';

      if ((self.info.mode != mode) || (self.status !== status)) {
        self.info.mode = mode;
        self.status = status;
        self.changed();
        self.refresh(self);
      }

      parser.parseString(event.Event.InstanceID[0].CurrentTrackMetaData[0].$.val, function(err, didl) {
        var track;

        if (err) {
          logger.error('device/' + self.deviceID,
                            { event      : 'xml2js.Parser'
                            , diagnostic : 'parseString'
                            , content    : event.Event.InstanceID[0].CurrentTrackMetaData[0].$.val
                            , exception  : err });
          return;
        }

        track = self.sonos.parseDIDL(didl);
        if ((self.info.track.title !== track.title)
                || (self.info.track.artist !== track.artist)
                || (self.info.track.album !== track.album)
                || (self.info.track.albumArtURI !== track.albumArtURI)) {
          delete(track.albumArtURL);
          self.info.track = track;
          self.changed();
        }
      });
    });
  }); } catch(ex) { logger.error('device/' + self.deviceID, { event: 'notify', diagnostic: ex.message }); }
};

Sonos_Audio.prototype.refresh = function(self) {
  if (!!self.refreshID) { clearTimeout(self.refreshID); self.refreshID = null; }

  self.sonos.currentTrack(function(err, track) {
    if (err) return self.error(self, err,  'currentTrack');

    if ((track !== undefined)
          && ((self.info.track.position !== (track.position * 1000))
               || (self.info.track.duration !== (track.duration * 1000)))) {
      delete(track.albumArtURL);
      self.info.track = track;
      self.info.track.position *= 1000;
      self.info.track.duration *= 1000;
      self.changed();
    }
  });

  self.sonos.getVolume(function(err, volume) {
    if (err) return self.error(self, err,  'getVolume');

    if ((volume !== undefined) && (self.info.volume !== volume)) {
      self.info.volume = volume;
      self.changed();
    }
  });

  self.sonos.getMuted(function(err, muted) {
    if (err) return self.error(self, err,  'getMuted');

    if ((muted !== undefined) && (self.info.muted !== (muted ? 'on' : 'off'))) {
      self.info.muted = muted ? 'on' : 'off';
      self.changed();
    }
  });

  self.refreshID = setTimeout (function() { self.refresh(self); }, (self.status === 'idle') ? (5 * 1000) : 350);
};

Sonos_Audio.prototype.error = function(self, err, event) {
  logger.error('device/' + self.deviceID, { event: event, diagnostic: err.message });
  if (self.status !== 'error') {
    self.status = 'error';
    self.changed();
  }
};

var validate_perform = function(perform, parameter) {
  var params = {}
    , result = { invalid: [], requires: [] }
    ;

  try { params = JSON.parse(parameter); } catch(ex) { result.invalid.push('parameter'); }
  switch (perform) {
    case 'set':
      if (!parameter) {
        result.requires.push('parameter');
        return result;
      }
      if ((!!params.mode) && (!({ normal: true, repeat: true, shuffle: true, shuffle1: true }[params.mode.toLowerCase()]))) {
        result.invalid.push('mode');
      }
      if ((!!params.position) && (!media.validPosition(params.position))) result.invalid.push('position');
      if ((!!params.volume) && (!media.validVolume(params.volume))) result.invalid.push('volume');
      if ((!!params.muted) && (params.muted !== 'on') && (params.muted !== 'off')) result.invalid.push('volume');
      break;

    case 'play':
      if (!!params.url) try { validator.check(params.url).isUrl(); } catch(ex) { result.invalid.push('url'); }
      break;

    case 'queueNext':
      if (!params.url) result.requires.push('url');
      else try { validator.check(params.url).isUrl(); } catch(ex) { result.invalid.push('url'); }
      break;

    case 'stop':
    case 'pause':
    case 'next':
    case 'previous':
    case 'flush':
      break;

    default:
      result.invalid.push('perform');
      break;
  }

  return result;
};


var Sonos_Bridge = function(deviceID, deviceUID, info) {
  var self;

  self = this;

  self.whatami = info.deviceType;
  self.deviceID = deviceID.toString();
  self.deviceUID = deviceUID;
  self.name = info.device.name;
  self.getName ();

  self.info = {};
  self.status = 'present';
  self.changed();

  utility.broker.subscribe('actors', function(request, taskID, actor, perform, parameter) {
    if (actor !== ('device/' + self.deviceID)) return;

    if (request === 'perform') return devices.perform(self, taskID, perform, parameter);
  });
};
util.inherits(Sonos_Bridge, media.Device);
Sonos_Bridge.prototype.perform = devices.perform;


exports.start = function() {
  steward.actors.device.media.sonos = steward.actors.device.media.sonos ||
      { $info     : { type: '/device/media/sonos' } };

  steward.actors.device.media.sonos.audio =
      { $info     : { type       : '/device/media/sonos/audio'
                    , observe    : [ ]
                    , perform    : [ 'play'
                                   , 'stop'
                                   , 'pause'
                                   , 'queueNext'
                                   , 'flush'
                                   , 'next'
                                   , 'previous'
                                   ]
                    , properties : { name    : true
                                   , status  : [ 'idle', 'playing', 'paused', 'busy', 'error' ]
                                   , track   : { title       : true
                                               , artist      : true
                                               , album       : true
                                               , albumArtURI : true
                                               , position    : 'milliseconds'
                                               , duration    : 'milliseconds'
                                               }
                                   , mode    : [ 'normal', 'repeat' , 'shuffle', 'shuffle1' ]
                                   , volume  : 'percentage'
                                   , muted   : [ 'on', 'off' ]
                                   }
                    }
      , $validate : { perform    : validate_perform }
      };
  devices.makers['urn:schemas-upnp-org:device:ZonePlayer:1'] = Sonos_Audio;

  steward.actors.device.gateway.sonos = steward.actors.device.gateway.sonos ||
      { $info     : { type: '/device/gateway/sonos' } };

  steward.actors.device.gateway.sonos.bridge =
      { $info     : { type       : '/device/gateway/sonos/bridge'
                    , observe    : [ ]
                    , perform    : [ ]
                    , properties : { name    : true
                                   , status  : [ 'present' ]
                                   }
                    }
      , $validate : { perform    : devices.validate_perform }
      };
  devices.makers['Sonos ZoneBridge ZB100'] = Sonos_Bridge;
};

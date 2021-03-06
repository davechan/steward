// Connected by TCP LED and CFL bulbs, powered by GreenWave Reality

var gop         = require('node-greenwave-gop')
  , util        = require('util')
  , url         = require('url')
  , db          = require('./../../core/database').db
  , devices     = require('./../../core/device')
  , steward     = require('./../../core/steward')
  , utility     = require('./../../core/utility')
  , broker      = utility.broker
  , lighting    = require('./../device-lighting')
  ;


var logger = lighting.logger;


var GreenWaveGOP = exports.Device = function(deviceID, deviceUID, info) {
  var self = this;

  self.whatami = info.deviceType;
  self.deviceID = deviceID.toString();
  self.deviceUID = deviceUID;
  self.name = info.device.name;
  self.getName();

  self.status = 'ready';

  self.info = {};

  self.controller = info.controller;
  self.controller.tag = 'device/' + self.deviceID;
  self.controller.removeAllListeners().on('update', function() {
    self.update(self);
  }).on('error', function(err) {
    logger.error('device/' + self.deviceID, { event: 'error', diagnostic: err.message });

    self.status = 'error';
    self.changed();
  });

  broker.subscribe('actors', function(request, taskID, actor, perform, parameter) {
    var led;

    if (request !== 'perform') return;

    deviceID = actor.split('/')[1];
    if (self.deviceID === deviceID) return devices.perform(self, taskID, perform, parameter);
    for (led in self.bulbs) {
      if (!self.bulbs.hasOwnProperty(led)) continue;

      if (self.bulbs[led].deviceID === deviceID) return self.perform(self, taskID, perform, parameter, led);
    }
  });

  self.update(self);
};
util.inherits(GreenWaveGOP, lighting.Device);


GreenWaveGOP.prototype.update = function(self) {
  var d, devices;

  self.status = 'ready';
  self.changed();

  self.bulbs = {};

  devices = self.controller.devices;
  for (d in devices) if (devices.hasOwnProperty(d)) self.addchild(self, devices[d]);
  self.changed();
};

GreenWaveGOP.prototype.addchild = function(self, device) {
  var deviceUID, led, whatami;

  led = device.did;

  deviceUID = self.deviceUID + '/bulbs/' + led;
  whatami = '/device/lighting/tcpi/led';
  self.bulbs[led] = { whatami  : whatami
                     , type    : whatami
                     , name    : device.name
                     , state   : { on         : device.state === 1
                                 , color      : { model : 'rgb'
                                                , rgb   : { r: 255, g: 255, b: 255 }
                                                , fixed: true
                                                }
                                 , brightness : { min   : device.rangemin
                                                , level : devices.scaledLevel(device.level, device.rangemin, device.rangemax)
                                                , max   : device.rangemax
                                                }
                                 }
                     , updated : self.updated
                     };

  db.get('SELECT deviceID, deviceType, deviceName FROM devices WHERE deviceUID=$deviceUID',
         { $deviceUID: deviceUID }, function(err, row) {
    if (err) {
      logger.error('device/' + self.deviceID, { event: 'SELECT device.deviceUID for LED ' + led, diagnostic: err.message });
      return;
    }

    if (row !== undefined) {
      self.bulbs[led].deviceID = row.deviceID.toString();
      self.bulbs[led].name = row.deviceName;
      return;
    }

    db.run('INSERT INTO devices(deviceUID, parentID, childID, deviceType, deviceName, created) '
           + 'VALUES($deviceUID, $parentID, $childID, $deviceType, $deviceName, datetime("now"))',
           { $deviceUID: deviceUID, $parentID: self.deviceID, $deviceType: whatami, $deviceName: self.bulbs[led].name,
             $childID: led }, function(err) {
      if (err) {
        logger.error('device/' + self.deviceID,
                     { event: 'INSERT device.deviceUID for LED ' + led, diagnostic: err.message });
        return;
      }

      self.bulbs[led].deviceID = this.lastID.toString();
    });
  });
};


GreenWaveGOP.prototype.children = function() {
  var self = this;

  var children, led;

  children = [];
  for (led in self.bulbs) if (self.bulbs.hasOwnProperty(led)) children.push(childprops(self, led));

  return children;
};

var childprops = function(self, led) {
  var child, props;

  props = self.bulbs[led];
  child = { id        : led
          , discovery : { id: led, source: 'device/' + self.deviceID  }
          , whatami   : props.type
          , whoami    : 'device/' + props.deviceID
          , name      : props.name
          , status    : props.state.on ? 'on' : 'off'
          , info      : { color: props.state.color, brightness: props.state.brightness.level }
          , deviceID  : props.deviceID
          , updated   : props.updated
          };

  child.proplist = devices.Device.prototype.proplist;
  child.setName = devices.Device.prototype.setName;

  child.perform = function(strip, taskID, perform, parameter) { return self.perform(self, taskID, perform, parameter, led); };

  return child;
};

GreenWaveGOP.prototype.perform = function(self, taskID, perform, parameter, led) {
  var bri, params, props, state;

  state = {};
  try { params = JSON.parse(parameter); } catch(ex) { params = {}; }

  props = self.bulbs[led];
  if (perform === 'set') {
    if (!params.name) return false;

    self.controller.setBulbName(led, params.name);

    return steward.performed(taskID);
  }

  if (perform === 'off') state.on = false;
  else if (perform !== 'on') return false;
  else {
    state.on = true;

    if ((!!params.brightness) && (!!props.state.brightness.min) && (!!props.state.brightness.max)) {
      if (!lighting.validBrightness(params.brightness)) return false;
      state.brightness = params.brightness;
      bri = devices.scaledPercentage(state.brightness, props.state.brightness.min,  props.state.brightness.max);
    }
  }

  logger.notice('device/' + self.deviceID, { perform: state });

  self.controller.setBulbLevel(led, state.on, bri);

  self.bulbs[led].state.on = state.on;
  self.bulbs[led].state.brightness.level = state.brightness;
  self.bulbs[led].updated = new Date().getTime();
  self.changed();

  return steward.performed(taskID);
};

var validate_perform = function(perform, parameter) {
  var params = {}
    , result = { invalid: [], requires: [] };

  if (perform === 'off') return result;

  if (!parameter) {
    result.requires.push('parameter');
    return result;
  }
  try { params = JSON.parse(parameter); } catch(ex) { result.invalid.push('parameter'); }

  if (perform === 'set') {
    if (!params.name) result.requires.push('name');
    return result;
  }

  if (perform !== 'on') {
    result.invalid.push('perform');
    return result;
  }

  if ((!!params.brightness) && (!lighting.validBrightness(params.brightness))) result.invalid.push('brightness');

  return result;
};


var scan = function () {
  var logger2 = utility.logger('discovery');

  new gop().on('discover', function(controller) {
    controller.on('update', function() {
      var info, serialNo;

      serialNo = controller.gateway.mac.split(':').join('');
      info = { source     : 'mdns'
             , controller : controller
             , device     : { url          : url.format(controller.options)
                            , name         : controller.params.host
                            , manufacturer : ''
                            , model        : { name        : controller.params.host
                                             , description : ''
                                             , number      : ''
                                             }
                            , unit         : { serial      : controller.gateway.serial
                                             , udn         : 'uuid:2f402f80-da50-11e1-9b23-'
                                                               + controller.gateway.mac.split(':').join('').toLowerCase()
                                             }
                            }
             , deviceType : steward.actors.device.gateway['greenwave-gop'].$info.type
           };
      info.url = info.device.url;
      info.deviceType = 'GreenWave GOP';
      info.deviceType2 = 'urn:schemas-upnp-org:device:Basic:1';
      info.id = info.device.unit.udn;
      if (!!devices.devices[info.id]) return;

      logger2.info(info.device.name, { url: info.url });
      devices.discover(info);
    }).on('error', function(err) {
      logger2.error(controller.params.name, { diagnostic: err.message });
    });
  }).on('error', function(err) {
    logger2.error('GreenWave GOP', { diagnostic: err.message });
  }).logger = logger2;
};


exports.start = function() {
  steward.actors.device.gateway['greenwave-gop'] = steward.actors.device.gateway['greenwave-gop'] ||
      { $info     : { type: '/device/gateway/greenwave-gop' } };

  steward.actors.device.gateway['greenwave-gop'].lighting =
      { $info     : { type       : '/device/gateway/greenwave-gop/lighting'
                    , observe    : [ ]
                    , perform    : [ ]
                    , properties : { name   : true
                                   , status : [ 'ready', 'error' ]
                                   }
                    }
      , $validate : { perform    : devices.validate_perform
                    }
      };
  devices.makers['GreenWave GOP'] = GreenWaveGOP;

  steward.actors.device.lighting.tcpi = steward.actors.device.lighting.tcpi ||
      { $info     : { type: '/device/lighting/tcpi' } };

  steward.actors.device.lighting.tcpi.led =
      { $info     : { type       : '/device/lighting/tcpi/led'
                    , observe    : [ ]
                    , perform    : [ 'off', 'on' ]
                    , properties : { name       : true
                                   , status     : [ 'on', 'off' ]
                                   , brightness : 'percentage'
                                   }
                    }
      , $validate : { perform    : validate_perform }
      };

  scan();
};

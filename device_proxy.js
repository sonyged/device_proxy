/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 */

'use strict';
let debug = require('debug')('device_proxy');

function Server(opts)
{
  let listener = opts.listener;
  let device = opts.device;

  this.device = device;
  device.start_scan(err => {
    device.stop_scan();
    if (err) {
      debug('device.start_scan failed', err);
      return;
    }
    debug('device.start_scan ok');
  });
  this.handler = {
    list: (reply, arg) => {
      let list = device.list();
      debug(`device-request: ${arg.request}`, list);
      reply(list, null);
    },
    device_scan: (reply, arg) => {
      device.start_scan(err => {
        device.stop_scan();
        if (err)
          debug('device.start_scan failed', err);
        else
          debug('device.start_scan ok');
        return reply(null, err);
      });
    },
    open: (reply, arg) => {
      debug(`device-request: ${arg.request}`, arg.arg.device);
      device.open(arg.arg.device, err => { reply(null, err); });
    },
    action: (reply, arg) => {
      let action = device.action();
      if (action) {
        action.action(arg.arg.block, arg.arg.arg, err => {
          debug(`device-request: reply err = ${err}`, arg);
          reply(err, err);
        });
      } else {
        debug(`action: null`, arg);
        reply(null, null);
      }
    },
    close: (reply, arg) => {
      debug(`device-request: ${arg.request}`);
      device.close(err => { reply(null, err); });
    },
    reset_koov: (reply, arg) => {
      debug(`device-request: ${arg.request}`);
      device.reset_koov(err => { reply(null, err); });
    },
    find_device: (reply, arg) => {
      debug(`device-request: ${arg.request}`, arg.arg.device);
      device.find_device(arg.arg.device, err => { reply(null, err); });
    },
    serial_open: (reply, arg) => {
      debug(`device-request: ${arg.request}`, arg.arg.device);
      device.serial_open(arg.arg.device, err => { reply(null, err); });
    },
    serial_write: (reply, arg) => {
      debug(`device-request: ${arg.request}`, arg.arg.data);
      device.serial_write(arg.arg.data, err => { reply(null, err); });
    },
    serial_event: (reply, arg, notify) => {
      debug(`device-request: ${arg.request}`, arg.arg.what);
      device.serial_event(arg.arg.what, err => {
        reply(null, err);
      }, (notification) => {
        notify({
          what: arg.arg.what,
          data: notification
        });
      });
    },
    serial_close: (reply, arg) => {
      debug(`device-request: ${arg.request}`);
      device.serial_close(err => { reply(null, err); });
    },
    /*
     * req.device: name of device file (if usb).
     * req.sketch: sketch binary in intel-hex format string.
     */
    'program-sketch': (reply, arg, notify) => {
      const req = arg.arg;
      device.program_sketch(req.device, req.sketch, (err) => {
        reply(null, err);
      }, (notification) => { notify(notification); });
    }
  };
  listener('device-request', (sender, arg) => {
    debug('device-request', arg);
    const reply = (response, error) => {
      //debug('device-reply', arg, response);
      sender('device-reply', {
        request: arg.request, arg: response, error: error, id: arg.id
      });
    };
    const notify = (notification) => {
      debug('device-notify', arg, notification);
      sender('device-notify', {
        request: arg.request, arg: notification, id: arg.id
      });
    };
    let handler = this.handler[arg.request];
    if (handler)
      handler(reply, arg, notify);
    else
      reply(null, `no such request ${arg.request}`);
  });
}

function Client(opts)
{
  let sender = opts.sender;
  let listener = opts.listener;
  if (opts.debug)
    debug = opts.debug;

  this.cmdid = 0;
  this.cmdq = [];
  this.cmdq_pending = [];
  this.notifier = {};
  this.serial_events = {};
  this.send_cmd = (cmd) => {
    this.cmdq.push(cmd);
    sender('device-request', {
      request: cmd.request, arg: cmd.arg, id: cmd.id
    });
  };
  this.send_pending = (type) => {
    let cmd = null;
    this.cmdq_pending = this.cmdq_pending.reduce((acc, x) => {
      if (!cmd && x.request === type)
        cmd = x;
      else
        acc.push(x);
      return acc;
    }, []);
    if (cmd) {
      debug('device_proxy: send_pending', type, cmd);
      this.send_cmd(cmd);
    } else {
      debug('device_proxy: send_pending: no cmd', type);
    }
  };
  this.request = (type, arg, cb) => {
    const id = this.cmdid++;
    const cmd = { request: type, arg: arg, callback: cb, id: id };
    if (this.cmdq.find(x => { return x.request === type; })) {
      //debug('device_proxy: defer', cmd);
      this.cmdq_pending.push(cmd);
    } else {
      this.send_cmd(cmd);
    }
  };
  listener('device-reply', (arg) => {
    let cmd = this.cmdq.find(x => { return x.id === arg.id; });
    if (cmd) {
      //debug('device_proxy: reply', cmd, arg);
      this.cmdq = this.cmdq.filter(x => { return x.id !== arg.id; });
      this.send_pending(cmd.request);
      cmd.callback(arg.error || arg.arg);
    } else {
      //debug('device_proxy: reply: no cmd found', arg);
    }
  });
  listener('device-notify', (arg) => {
    //debug('device_notify:', arg);
    const notifier = this.notifier[arg.request];
    if (notifier)
      notifier(arg.arg);
  });
  this.action = () => {
    return {
      action: (block, arg, cb) => {
        debug('device_proxy: action', block);
        this.request('action', { block: block, arg: arg }, cb);
      }
    };
  };
  this.list = (cb) => {
    this.request('list', {}, cb);
  };
  this.device_scan = (cb) => {
    this.request('device_scan', {}, cb);
  };
  this.open = (device, cb) => {
    this.request('open', { device: device }, cb);
  };
  this.close = (cb) => {
    this.request('close', {}, cb);
  };
  this.find_device = (device, cb) => {
    this.request('find_device', { device: device }, cb);
  };
  this.serial_open = (device, cb) => {
    this.request('serial_open', { device: device }, cb);
  };
  this.serial_write = (data, cb) => {
    this.request('serial_write', { data: data }, cb);
  };
  this.notifier['serial_event'] = (data) => {
    const notify = this.serial_events[event_name];
    if (notify)
      notify(data);
  };
  this.serial_event = (what, cb, notify) => {
    const event_name = `serial-event:${what}`;
    this.serial_events[event_name] = notify;
    this.request('serial_event', { what: event_name }, cb);
  };
  this.serial_close = (cb) => {
    this.request('serial_close', {}, cb);
  };
  this.program_sketch = (device, sketch, cb, progress) => {
    this.notifier['program-sketch'] = progress;
    this.request('program-sketch', { device: device, sketch: sketch }, (err) => {
      this.notifier['program-sketch'] = null;
      cb(err);
    });
  };
}

module.exports = {
  server: (opts) => { return new Server(opts); },
  client: (opts) => { return new Client(opts); },
};

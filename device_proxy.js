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
      //debug(`device-request: ${arg.request}`, arg.arg.device);
      device.open(arg.arg.device, err => { reply(null, err); });
    },
    action: (reply, arg) => {
      let action = device.action();
      if (action) {
        action.action(arg.arg.block, arg.arg.arg, err => {
          //debug(`device-request: reply err = ${err}`, arg);
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
      debug(`device-request: ${arg.request}`, arg);
      device.serial_open(err => { reply(null, err); });
    },
    serial_write: (reply, arg) => {
      //debug(`device-request: ${arg.request}`, arg.arg.data);
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
    //debug('listener: device-request', arg);
    const reply = (response, error) => {
      //debug('listener: device-request: reply', arg, response);
      sender('device-reply', {
        request: arg.request, arg: response, error: error, id: arg.id
      });
    };
    const notify = (notification) => {
      //debug('device-notify', arg, notification);
      sender('device-notify', {
        request: arg.request, arg: notification, id: arg.id
      });
    };
    let handler = this.handler[arg.request];
    //debug('device-request: handler', handler);
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
  let command_timeout = 60000;
  if (opts.debug)
    debug = opts.debug;
  if (opts.command_timeout)
    command_timeout = opts.command_timeout;

  this.cmdid = 0;
  this.current_cmd = null;
  this.timeout_id = null;
  this.cmdq = [];
  this.notifier = {};
  this.serial_events = {};

  const flush_cmdq = () => {
    while (true) {
      const cmd = this.cmdq.pop();
      if (!cmd)
        return;
      debug('flusing cmd:', cmd.id);
      cmd.cb();
    }
  };

  const drop_cmd = (id) => {
    this.cmdq = this.cmdq.filter(x => { return x.id !== id; });
  };

  const drop_expired = (cmd) => {
    this.timeout_id = null;
    if (!this.current_cmd) {
      debug('drop_expired: no current command');
      return;
    }
    if (cmd.id !== this.current_cmd.id) {
      debug('drop_expired: id mismatch', cmd.id, this.current_cmd.id);
      return;
    }
    this.current_cmd = null;
    drop_cmd(cmd.id);
    debug('drop_expired: drop command', cmd.id);
    setTimeout(send_cmd, 0);
    return cmd.callback({ msg: 'command timeout' });
  };

  const send_cmd = () => {
    if (this.current_cmd !== null ||
        this.cmdq.length === 0)
      return;

    //debug('send_cmd:', this.cmdq);
    const cmd = this.cmdq[0];
    const now = Date.now();
    if (now > cmd.timestamp + command_timeout) {
      debug('send_cmd: drop due to out of date', cmd);
      this.cmdq.pop();
      setTimeout(send_cmd, 0);
      return cmd.callback({ msg: 'command timeout' });
    }
    this.current_cmd = cmd;
    this.timeout_id = setTimeout(() => { drop_expired(cmd); }, command_timeout);
    //debug('send_cmd: dequeue', cmd);
    return sender('device-request', {
      request: cmd.request, arg: cmd.arg, id: cmd.id
    });
  };
  this.send_cmd = (cmd) => {
    this.cmdq.push(cmd);
    send_cmd();
  };
  this.request = (type, arg, cb) => {
    const id = this.cmdid++;
    const cmd = {
      request: type,
      arg: arg,
      callback: cb,
      id: id,
      timestamp: Date.now()
    };
    //debug('device_proxy: request (enqueue)', cmd);
    this.send_cmd(cmd);
  };
  listener('device-reply', (arg) => {
    //debug('device_proxy: reply', arg);
    let cmd = this.cmdq.find(x => { return x.id === arg.id; });
    if (cmd) {
      drop_cmd(arg.id);
      this.current_cmd = null;
      if (this.timeout_id) {
        clearTimeout(this.timeout_id);
        this.timeout_id = null;
      }
      setTimeout(send_cmd, 0);
      return cmd.callback(arg.error || arg.arg);
    } else {
      debug('device_proxy: reply: no cmd found', arg, this.cmdq);
    }
  });
  listener('device-notify', (arg) => {
    //debug('device_notify:', arg);
    const notifier = this.notifier[arg.request];
    if (notifier)
      notifier(arg.arg);
  });

  this.reset = (cb) => {
    flush_cmdq();
    this.current_cmd = null;
    this.notifier = {};
    this.serial_events = {};
    return cb(null);
  };
  this.action = () => {
    return {
      action: (block, arg, cb) => {
        //debug('device_proxy: action', block);
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
  this.reset_koov = (cb) => {
    this.request('reset_koov', {}, cb);
  };
  this.find_device = (device, cb) => {
    this.request('find_device', { device: device }, cb);
  };
  this.serial_open = (cb) => {
    this.request('serial_open', {}, cb);
  };
  this.serial_write = (data, cb) => {
    this.request('serial_write', { data: data }, cb);
  };
  this.notifier['serial_event'] = (arg) => {
    //debug('notifier: serial_event', arg);
    const notify = this.serial_events[arg.what];
    if (notify) {
      notify(arg.data);
    } else
      debug('notifer: not found', arg);
  };
  this.serial_event = (what, cb, notify) => {
    const event_name = `serial-event:${what}`;
    this.serial_events[event_name] = notify;
    this.request('serial_event', { what: event_name }, cb);
  };
  this.program_serial = () => {
    /*
     * serial wrapper for stk500v2 module.
     */
    const serial = {
      path: 'dummy',        // this is necessary.
      open: (callback) => { return callback(null); },
      on: (what, callback) => { this.serial_event(what, () => {}, callback); },
      close: (callback) => { this.close(callback); },
      write: (data, callback) => { return this.serial_write(data, callback); },
      drain: (callback) => {
        //debug('drain called');
        callback(null);
      },
    };
    return serial;
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

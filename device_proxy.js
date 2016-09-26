/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 */

'use strict';
let debug = require('debug')('device_proxy');

const DEVICE_PROXY_ERROR = 0xfd;

const PROXY_NO_ERROR = 0x00;
const PROXY_UNKNOWN_REQUEST = 0x01;  // no matching request found.
const PROXY_CMD_TERMINATED = 0x02;
const PROXY_CMD_RESETTED = 0x03; // terminated due to resetting
const PROXY_CMD_TIMEDOUT = 0x04; // command just timed out.

const error_p = (err) => {
  if (!err)
    return false;
  if (typeof err === 'object')
    return !!err.error;
  return true;
};

const make_error = (tag, err) => {
  if (tag === PROXY_NO_ERROR)
    return err;
  const original_err = err;
  if (typeof err === 'string')
    err = { msg: err };
  if (typeof err !== 'object' || err === null)
    err = { msg: 'unknown error' };
  err.error = true;
  err.original_error = JSON.stringify(original_err);
  if (!err.error_code)
    err.error_code = ((DEVICE_PROXY_ERROR << 8) | tag) & 0xffff;
  return err;
};

const error = (tag, err, cb) => {
  return cb(make_error(tag, err));
};

function Server(opts)
{
  let listener = opts.listener;
  let device = opts.device;

  this.device = device;
  device.start_scan(err => {
    device.stop_scan();
    if (error_p(err)) {
      debug('device.start_scan failed', err);
      return;
    }
    debug('device.start_scan ok');
  });
  this.handler = {
    /*
     * Return list of found devices by scan.  No argument.
     */
    list: (reply, arg) => {
      let list = device.list();
      debug(`device-request: ${arg.request}`, list);
      return error(PROXY_NO_ERROR, null, (err) => reply(list, err));
    },
    /*
     * Start device scan.  No argument.
     */
    device_scan: (reply, arg) => {
      device.start_scan(err => {
        device.stop_scan();
        if (error_p(err))
          debug('device.start_scan failed', err);
        else
          debug('device.start_scan ok');
        return reply(null, err);
      });
    },
    /*
     * Open specified device.  The argument is one of elements
     * returned by `list' command above.
     */
    open: (reply, arg) => {
      //debug(`device-request: ${arg.request}`, arg.arg.device);
      device.open(arg.arg.device, err => reply(null, err));
    },
    /*
     * Close currently opened device.  Nop if nothing is opened.  No
     * argument.
     */
    close: (reply, arg) => {
      debug(`device-request: ${arg.request}`);
      device.close(err => reply(null, err));
    },
    /*
     * Reset currently selected device and put it into bootloader
     * mode.  No argument.
     */
    reset_koov: (reply, arg) => {
      debug(`device-request: ${arg.request}`);
      device.reset_koov(err => reply(null, err));
    },
    /*
     * Set specified device.  The argument is one of element returned
     * by `list' command above.
     */
    find_device: (reply, arg) => {
      debug(`device-request: ${arg.request}`, arg.arg.device);
      device.find_device(arg.arg.device, err => reply(null, err));
    },
    /*
     * Open selected device by `find_device' command above.
     */
    serial_open: (reply, arg) => {
      debug(`device-request: ${arg.request}`, arg);
      device.serial_open(err => reply(null, err));
    },
    /*
     * Write data to currently opened device.  The argument is data to
     * be writtend.
     */
    serial_write: (reply, arg) => {
      //debug(`device-request: ${arg.request}`, arg.arg.data);
      device.serial_write(arg.arg.data, err => {
        //debug(`device-request: ${arg.request} =>`, err);
        reply(null, err);
      });
    },
    /*
     * Set up listener for given event.  The argument is type of event
     * and callback to notify the event.
     */
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
    }
  };
  listener('device-request', (sender, arg) => {
    //debug('listener: device-request', arg);
    const reply = (response, err) => {
      //debug('listener: device-request: reply', arg, response);
      sender('device-reply', {
        request: arg.request, arg: response, error: err, id: arg.id
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
      return error(PROXY_UNKNOWN_REQUEST, {
        msg: `no such request ${arg.request}`
      }, err => reply(null, err));
  });
}

function Client(opts)
{
  let sender = opts.sender;
  let listener = opts.listener;
  let command_timeout = 20000;
  const client_version = { major: 1, minor: 0, patch: 2 };
  if (opts.debug)
    debug = opts.debug;
  if (opts.command_timeout)
    command_timeout = opts.command_timeout;

  this.terminated = false;
  this.cmdid = 0;
  this.current_cmd = null;
  this.timeout_id = null;
  this.cmdq = [];
  this.notifier = {};
  this.serial_events = {};

  const flush_cmdq = (tag) => {
    while (true) {
      const cmd = this.cmdq.pop();
      if (!cmd)
        return;
      //debug('flusing cmd:', cmd);
      error(tag, 'command terminated', cmd.callback);
    }
  };

  const dequeue_cmd = (id) => {
    this.cmdq = this.cmdq.filter(x => { return x.id !== id; });
  };

  const drop_cmd = (tag, cmd, send_next, reason) => {
    this.timeout_id = null;
    if (!this.current_cmd) {
      debug('drop_cmd: no current command');
      return;
    }
    if (cmd.id !== this.current_cmd.id) {
      debug('drop_cmd: id mismatch', cmd.id, this.current_cmd.id);
      return;
    }
    this.current_cmd = null;
    dequeue_cmd(cmd.id);
    //debug('drop_cmd: drop command', cmd);
    if (send_next)
      setImmediate(send_cmd);
    return error(tag, { msg: reason }, cmd.callback);
  };

  const drop_expired = (cmd) => {
    return drop_cmd(PROXY_CMD_TIMEDOUT, cmd, true, 'command timeout');
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
      setImmediate(send_cmd);
      return error(PROXY_CMD_TIMEDOUT, {
        msg: 'command timeout'
      }, cmd.callback);
    }
    this.current_cmd = cmd;
    this.timeout_id = setTimeout(() => {
      drop_expired(cmd);
    }, command_timeout);
    //debug('send_cmd: dequeue', cmd);
    return sender('device-request', {
      version: client_version, request: cmd.request, arg: cmd.arg, id: cmd.id
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
      dequeue_cmd(arg.id);
      this.current_cmd = null;
      if (this.timeout_id) {
        clearTimeout(this.timeout_id);
        this.timeout_id = null;
      }
      setImmediate(send_cmd);
      const decode_arg = () => {
        if (arg.error) {
          if (typeof arg.error === 'object') {
            if (!arg.error.hasOwnProperty('error'))
              arg.error.error = true;
            return arg.error;
          }
          if (typeof arg.error === 'string')
            return { error: true, msg: arg.error };
          return { error: true, msg: 'Unknown error', arg: arg };
        }
        return arg.arg;
      };
      return cmd.callback(decode_arg());
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
    flush_cmdq(PROXY_CMD_RESETTED);
    this.current_cmd = null;
    this.notifier = {};
    this.serial_events = {};
    this.terminated = false;
    return error(PROXY_NO_ERROR, null, cb);
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
  this.terminate = (cb) => {
    debug('device_proxy: terminate', this.current_cmd);
    if (this.current_cmd)
      drop_cmd(PROXY_CMD_TERMINATED, this.current_cmd, false,
               'command terminated');
    flush_cmdq(PROXY_CMD_TERMINATED);
    return error(PROXY_NO_ERROR, null, cb);
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
}

module.exports = {
  server: (opts) => { return new Server(opts); },
  client: (opts) => { return new Client(opts); },
};

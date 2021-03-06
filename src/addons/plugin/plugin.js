/**
 * @module Plugin
 *
 * Object created for each plugin that the gateway talks to.
 */
/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

const AdapterProxy = require('./adapter-proxy');
const Constants = require('../addon-constants');
const DeviceProxy = require('./device-proxy');
const IpcSocket = require('./ipc');
const readline = require('readline');
const spawn = require('child_process').spawn;

const DEBUG = false;

class Plugin {

  constructor(pluginId, pluginServer) {
    this.pluginId = pluginId;
    this.pluginServer = pluginServer;
    this.logPrefix = pluginId.replace('-adapter', '');

    this.adapters = new Map();
    this.ipcBaseAddr = 'gateway.plugin.' + this.pluginId;

    this.ipcSocket = new IpcSocket('AdapterProxy', 'pair',
                                   this.ipcBaseAddr,
                                   this.onMsg.bind(this));
    this.ipcSocket.bind();
    this.deferredUnload = null;
    this.exec = '';
    this.process = null;
    this.restart = true;
  }

  asDict() {
    let pid = 'not running';
    if (this.process) {
      pid = this.process.pid;
    }
    return {
      pluginId: this.pluginId,
      ipcBaseAddr: this.ipcBaseAddr,
      adapters: Array.from(this.adapters.values()).map(adapter => {
        return adapter.asDict();
      }),
      exec: this.exec,
      pid: pid,
    };
  }

  onMsg(msg) {
    DEBUG && console.log('Plugin: Rcvd Msg', msg);
    var adapterId = msg.data.adapterId;
    var adapter;
    var deferredUnload;

    // The first switch manages plugin level messages.
    switch (msg.messageType) {
      case Constants.ADD_ADAPTER:
        adapter = new AdapterProxy(this.pluginServer.manager, adapterId, this);
        adapter.name = msg.data.name;
        this.adapters.set(adapterId, adapter);
        this.pluginServer.addAdapter(adapter);
        return;

      case Constants.PLUGIN_UNLOADED:
        this.shutdown();
        this.pluginServer.unregisterPlugin(msg.data.pluginId);
        deferredUnload = this.deferredUnload;
        if (deferredUnload) {
          this.deferredUnload = null;
          deferredUnload.resolve();
        }
        return;
    }

    // The next switch deals with adapter level messages

    adapter = this.adapters.get(adapterId);
    if (!adapter) {
      console.error('Plugin:', this.pluginId,
                    'Unregcognized adapter:', adapterId,
                    'Ignoring msg:', msg);
      return;
    }

    var device;
    var property;
    var deferredMock;

    switch (msg.messageType) {

      case Constants.ADAPTER_UNLOADED:
        this.adapters.delete(adapterId);
        if (this.adapters.size == 0) {
          // We may need to reevaluate this, and only auto-unload
          // the plugin for the MockAdapter. For plugins which
          // support hot-swappable dongles (like zwave/zigbee) it makes
          // sense to have a plugin loaded with no adapters present.
          this.unload();
          this.deferredUnload = adapter.deferredUnload;
          adapter.deferredUnload = null;
        } else {
          let deferredUnload = adapter.deferredUnload;
          if (deferredUnload) {
            adapter.deferredUnload = null;
            deferredUnload.resolve();
          }
        }
        break;

      case Constants.HANDLE_DEVICE_ADDED:
        device = new DeviceProxy(adapter, msg.data);
        adapter.handleDeviceAdded(device);
        break;

      case Constants.HANDLE_DEVICE_REMOVED:
        device = adapter.getDevice(msg.data.id);
        if (device) {
          adapter.handleDeviceRemoved(device);
        }
        break;

      case Constants.PROPERTY_CHANGED:
        device = adapter.getDevice(msg.data.deviceId);
        if (device) {
          property = device.findProperty(msg.data.property.name);
          if (property) {
            property.doPropertyChanged(msg.data.property);
            device.notifyPropertyChanged(property);
          }
        }
        break;

      case Constants.MOCK_ADAPTER_STATE_CLEARED:
        deferredMock = adapter.deferredMock;
        if (!deferredMock) {
          console.error('mockAdapterStateCleared: No deferredMock');
        } else {
          adapter.deferredMock = null;
          deferredMock.resolve();
        }
        break;

      case Constants.MOCK_DEVICE_ADDED_REMOVED:
        deferredMock = adapter.deferredMock;
        if (!deferredMock) {
          console.error('mockDeviceAddedRemoved: No deferredMock');
        } else {
          device = deferredMock.device;
          adapter.deferredMock = null;
          deferredMock.device = null;
          deferredMock.resolve(device);
        }
        break;

      case Constants.MOCK_DEVICE_ADD_REMOVE_FAILED:
        deferredMock = adapter.deferredMock;
        if (!deferredMock) {
          console.error('Plugin:', this.pluginId,
                        'Adapter:', adapter.getId(),
                        'No deferredMock');
        } else {
          adapter.deferredMock = null;
          deferredMock.reject(msg.data.error);
        }
        break;

      default:
        console.error('Plugin: unrecognized msg:', msg);
        break;
    }
  }

  sendMsg(methodType, data) {
    data.pluginId = this.pluginId;
    var msg = {
      messageType: methodType,
      data: data,
    };
    DEBUG && console.log('Plugin: sendMsg:', msg);
    return this.ipcSocket.sendJson(msg);
  }

  /**
   * Does cleanup required to allow the test suite to complete cleanly.
   */
  shutdown() {
    this.ipcSocket.close();
  }

  start() {
    // If we need embedded spaces, then consider changing to use the npm
    // module called splitargs
    this.restart = true;
    let args = this.exec.split(' ');
    this.process = spawn(args[0], args.slice(1));

    this.process.on('error', err => {
      // We failed to spawn the process. This most likely means that the
      // exec string is malformed somehow. Report the error but don't try
      // restarting.
      this.restart = false;
      console.error('Failed to start plugin', this.pluginId);
      console.error('Command:', this.exec);
      console.error(err);
    });

    this.stdoutReadline = readline.createInterface({
      input: this.process.stdout
    });
    this.stdoutReadline.on('line', line => {
      console.log(this.logPrefix + ': ' + line);
    });

    this.stderrReadline = readline.createInterface({
      input: this.process.stderr
    });
    this.stderrReadline.on('line', line => {
      console.error(this.logPrefix + ': ' + line);
    });

    this.process.on('exit', code => {
      if (this.restart) {
        if (code == Constants.DONT_RESTART_EXIT_CODE) {
          console.log('Plugin:', this.pluginId, 'died, code =', code,
                      'NOT restarting...');
          this.restart = false;
        } else {
          console.log('Plugin:', this.pluginId, 'died, code =', code,
                      'restarting...');
          this.start();
        }
      }
    });
  }

  unload() {
    this.restart = false;
    this.sendMsg(Constants.UNLOAD_PLUGIN, {});
  }
}

module.exports = Plugin;

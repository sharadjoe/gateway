/*
 * Add-on Loader app.
 *
 * This app will load an add-on as a standalone process.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

var config = require('config');
const Constants = require('./constants');
const GetOpt = require('node-getopt');
const PluginClient = require('./addons/plugin/plugin-client');
const fs = require('fs');
const path = require('path');

async function loadAddon(packageName, verbose) {
  const addonPath = path.join(__dirname,
                              config.get('addonManager.path'),
                              packageName);

  // Skip if there's no package.json file.
  const packageJson = path.join(addonPath, 'package.json');
  if (!fs.lstatSync(packageJson).isFile()) {
    const err = `package.json not found for package: ${packageName}`;
    return Promise.reject(err);
  }

  // Read the package.json file.
  let data;
  try {
    data = fs.readFileSync(packageJson);
  } catch (e) {
    const err =
      `Failed to read package.json for package: ${packageName}\n${e}`;
    return Promise.reject(err);
}

  let manifest;
  try {
    manifest = JSON.parse(data);
  } catch (e) {
    const err =
      `Failed to parse package.json for package: ${packageName}\n${e}`;
    return Promise.reject(err);
  }

  // Verify API version.
  const apiVersion = config.get('addonManager.api');
  if (manifest.moziot.api.min > apiVersion ||
      manifest.moziot.api.max < apiVersion) {
    return Promise.reject(
      `API mismatch for package: ${manifest.name}\n` +
      `Current: ${apiVersion} ` +
      `Supported: ${manifest.moziot.api.min}-${manifest.moziot.api.max}`);
  }
  let newSettings = Object.assign({}, manifest);
  if (!newSettings.moziot.hasOwnProperty('config')) {
    newSettings.moziot.config = {};
  }

  const errorCallback = function(packageName, errorStr) {
    console.error('Failed to load', packageName, '-', errorStr);
  };

  var pluginClient = new PluginClient(packageName, {verbose: verbose});
  return new Promise((resolve, reject) => {
    pluginClient.register().then(addonManagerProxy => {
      console.log('Loading add-on for', manifest.name,
                  'from', addonPath);
      let addonLoader = dynamicRequire(addonPath);
      addonLoader(addonManagerProxy, newSettings, errorCallback);
      resolve();
    }).catch(e => {
      console.error(e);
      const err =
        `Failed to register package: ${manifest.name} with gateway`;
      reject(err);
    });
  });
}

// Use webpack provided require for dynamic includes from the bundle  .
const dynamicRequire = (() => {
  if (typeof __non_webpack_require__ !== 'undefined') {
    // eslint-disable-next-line no-undef
    return __non_webpack_require__;
  }
  return require;
})();

// Get some decent error messages for unhandled rejections. This is
// often just errors in the code.
process.on('unhandledRejection', (reason) => {
  console.log('Unhandled Rejection');
  console.error(reason);
});

// Command line arguments
const getopt = new GetOpt([
  ['h', 'help', 'Display help' ],
  ['v', 'verbose', 'Show verbose output'],
]);

const opt = getopt.parseSystem();

if (opt.options.verbose) {
  console.log(opt);
}

if (opt.options.help) {
  getopt.showHelp();
  process.exit(Constants.DONT_RESTART_EXIT_CODE);
}

if (opt.argv.length != 1) {
  console.error('Expecting a single package to load');
  process.exit(Constants.DONT_RESTART_EXIT_CODE);
}
var packageName = opt.argv[0];

loadAddon(packageName, opt.verbose).catch(err => {
  console.error(err);
  process.exit(Constants.DONT_RESTART_EXIT_CODE);
});

'use strict';

const Command = require('cmnd').Command;
const APIResource = require('api-res');
const Credentials = require('../credentials.js');
const fileio = require('../fileio.js');

const async = require('async');
const inquirer = require('inquirer');

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const lib = require('lib');

const spawnSync = require('child_process').spawnSync;

const DEFAULT_BUILD = 'faaslang';
const OTHER_BUILDS = ['legacy'];

function deepAssign(o1, o2) {
  Object.keys(o2).forEach(k => {
    if (
      o1[k] && o2[k] &&
      typeof o1[k] === 'object' && typeof o2[k] === 'object'
    ) {
      deepAssign(o1[k], o2[k]);
    } else {
      o1[k] = o2[k];
    }
  });
}

class CreateCommand extends Command {

  constructor() {

    super('create');

  }

  help() {

    return {
      description: 'Creates a new (local) service',
      args: [
        'service'
      ],
      flags: {
        n: 'No login - don\'t require an internet connection',
        w: 'Write over - overwrite the current directory contents',
        t: 'Template - a stdlib service template to use',
        d: 'Dev Mode - Specify another HTTP address for the Template Service (e.g. localhost:8170)',
        b: `Build - Specify build, ${DEFAULT_BUILD} (default) or ${OTHER_BUILDS.map(v => `"${v}"`).join(', ')}`
      },
      vflags: {
        'no-login': 'No login - don\'t require an internet connection',
        'write-over': 'Write over - overwrite the current directory contents',
        'template': 'Template - a stdlib service template to use',
        'develop': 'Dev Mode - Specify another HTTP address for the Template Service (e.g. localhost:8170)',
        'build': `Build - Specify build, ${DEFAULT_BUILD} (default) or ${OTHER_BUILDS.map(v => `"${v}"`).join(', ')}`
      }
    };

  }

  run(params, callback) {

    let name = params.args[0];

    let host = params.flags.h ? params.flags.h[0] : 'https://api.polybit.com';
    let port = params.flags.p && params.flags.p[0];

    let nologin = params.flags.hasOwnProperty('n') || params.vflags.hasOwnProperty('no-login');

    let force = params.flags.hasOwnProperty('f') || params.vflags.hasOwnProperty('force');
    let write = params.flags.hasOwnProperty('w') || params.vflags.hasOwnProperty('write-over');
    let tdev = params.flags.hasOwnProperty('tdev');

    let develop = (params.flags.d || params.vflags.develop || [])[0];
    let build = (params.flags.b || params.vflags.build || [])[0] || DEFAULT_BUILD;

    if ([DEFAULT_BUILD].concat(OTHER_BUILDS).indexOf(build) === -1) {
      return callback(new Error(`Invalid build: "${build}"`));
    }

    let extPkgName = (params.flags.t || params.vflags.template || [])[0];
    let extPkg = null;

    if (!force && !Credentials.location(1)) {
      console.log();
      console.log(chalk.bold.red('Oops!'));
      console.log();
      console.log(`You're trying to create a new service in development,`);
      console.log(`But you're not in a root stdlib project directory.`);
      console.log(`We recommend against this.`);
      console.log();
      console.log(`Use ${chalk.bold('lib create --force')} to override.`);
      console.log();
      return callback(null);
    }

    console.log();
    console.log(`Awesome! Let's create a ${chalk.bold.green('stdlib')} service!`);
    extPkgName && console.log(`We'll use the template ${chalk.bold.green(extPkgName)} to proceed.`);
    console.log();

    let questions = [];

    name || questions.push({
      name: 'name',
      type: 'input',
      default: '',
      message: 'Service Name'
    });

    let login = [];
    !nologin && login.push((cb) => {

      let resource = new APIResource(host, port);
      resource.authorize(Credentials.read('ACCESS_TOKEN'));

      resource.request('v1/users').index({me: true}, (err, response) => {

        if (err) {
          return cb(err);
        }

        return cb(null, response.data[0]);

      });

    });

    inquirer.prompt(questions, (promptResult) => {

      name = name || promptResult.name;
      let username;

      if (name.indexOf('/') > -1) {
        username = name.split('/')[0];
        name = name.split('/').slice(1).join('/').replace(/\//g, '-');
      }

      // NOTE: Not offline friendly. Always log in user...
      // login = username ? [] : login;

      async.series(login, (err, results) => {

        if (err) {
          return callback(err);
        }

        let defaultUser = {username: 'dev', email: ''};
        let user = nologin ? defaultUser : results[0];
        user = user || defaultUser;

        username = username || user.username;

        // Do template fetching...
        let extPkgCalls = [];

        if (extPkgName) {

          console.log(`Fetching template ${chalk.bold.green(extPkgName)}...`);
          console.log();
          let utils = develop ?
            lib({host: develop.split(':')[0], port: develop.split(':')[1]}).utils :
            lib.utils;

          extPkgCalls = [
            cb => {
              utils.templates[develop ? '@local' : '@release'].package({name: extPkgName}, (err, result) => {
                cb(err, result);
              });
            },
            cb => {
              utils.templates[develop ? '@local' : '@release'].files({name: extPkgName}, (err, result) => {
                cb(err, result);
              });
            }
          ];

        }

        async.series(extPkgCalls, (err, results) => {

          if (err) {
            return callback(new Error(`Error retrieving template: ${extPkgName}`));
          }

          if (results.length === 2) {
            extPkg = {
              pkg: results[0],
              files: results[1]
            };
          }

          !fs.existsSync(username) && fs.mkdirSync(username);
          let serviceName = [username, name].join('/');
          let servicePath = path.join(process.cwd(), username, name);
          let fPath = path.join(servicePath, 'functions');
          let functionPath;

          if (fs.existsSync(servicePath)) {

            if (!write) {

              console.log();
              console.log(chalk.bold.red('Oops!'));
              console.log();
              console.log(`The directory you're creating a stdlib project in already exists:`);
              console.log(`  ${chalk.bold(servicePath)}`);
              console.log();
              console.log(`Try removing the existing directory first.`);
              console.log();
              console.log(`Use ${chalk.bold('lib create --write-over')} to override.`);
              console.log();
              return callback(null);

            }

          } else {

            fs.mkdirSync(servicePath);
            fs.mkdirSync(fPath);

          }

          let json = {
            pkg: require(path.join(__dirname, `../templates/${build}/package.json`))
          };

          json.pkg.name = name;
          json.pkg.author = user.username + (user.email ? ` <${user.email}>` : '');
          json.pkg.stdlib.name = [username, name].join('/');
          json.pkg.stdlib.build = build;

          // EXTERNAL: Assign package details
          if (extPkg && extPkg.pkg) {
            let extBuild = extPkg.pkg &&
              extPkg.pkg.stdlib &&
              extPkg.pkg.stdlib.build ||
              DEFAULT_BUILD;
            if (build !== extBuild) {
              return callback(new Error(
                `Can not use this template with this build\n` +
                `Try \`lib create -t ${extPkgName} -b ${extBuild}\` instead`
              ));
            }
            deepAssign(json.pkg, extPkg.pkg);
          }

          fileio.writeFiles(
            serviceName,
            fileio.readTemplateFiles(
              path.join(__dirname, '..', 'templates', build)
            )
          );

          fs.writeFileSync(
            path.join(servicePath, 'package.json'),
            JSON.stringify(json.pkg, null, 2)
          );

          let fns = [];
          if (extPkg && extPkg.files && extPkg.files.length) {
            fns.push(cb => {
              fileio.extract(serviceName, extPkg.files, (err) => {
                if (err) {
                  console.error(err);
                  return cb(new Error(`Could not install template ${extPkgName}`));
                }
                cb();
              });
            });
          }

          async.series(fns, (err) => {

            if (err) {
              return callback(err);
            }

            if (
              (json.pkg.dependencies && Object.keys(json.pkg.dependencies).length) ||
              (json.pkg.devDependencies && Object.keys(json.pkg.devDependencies).length)
            ) {
              console.log(`Installing npm packages...`);
              console.log();
              let command = spawnSync(
                /^win/.test(process.platform) ? 'npm.cmd' : 'npm',
                ['install'],
                {
                  stdio: [0, 1, 2],
                  cwd: servicePath,
                  env: process.env
                }
              );
              if (command.status !== 0) {
                console.log(command.error);
                console.log(chalk.bold.yellow('Warn: ') + 'Error with npm install');
              }
            }

            console.log(chalk.bold.green('Success!'));
            console.log();
            console.log(`Service ${chalk.bold([username, name].join('/'))} created at:`);
            console.log(`  ${chalk.bold(servicePath)}`);
            console.log();
            console.log(`Use the following to enter your service directory:`);
            console.log(`  ${chalk.bold('cd ' + [username, name].join('/'))}`);
            console.log();
            console.log(`Type ${chalk.bold('lib help')} for more commands.`);
            console.log();
            return callback(null);

          });

        });

      });

    });

  }

}

module.exports = CreateCommand;

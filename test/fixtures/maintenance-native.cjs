// Harness only: invokes the private controller after a real first boot.
const { app, BrowserWindow, utilityProcess, dialog } = require('electron');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { basename } = require('node:path');

const report = line => process.stderr.write(`LUME_MAINT_NATIVE=${line}\n`);
dialog.showErrorBox = (title, message) => report(`DIALOG:${title}:${message}`);
BrowserWindow.prototype.show = function () {};
let windows = 0, utilities = 0, controllers = 0, webLoads = 0;
app.on('browser-window-created', () => { windows++; report(`WINDOWS:${windows}`); });
const originalLoadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = async function (file, ...rest) {
  const result = await originalLoadFile.call(this, file, ...rest);
  if (basename(file) === 'maintenance.html') report('LOCAL_LOADED');
  return result;
};
const originalLoadURL = BrowserWindow.prototype.loadURL;
BrowserWindow.prototype.loadURL = function (url, ...rest) {
  webLoads++; report(`WEB_LOAD:${webLoads}`);
  return originalLoadURL.call(this, url, ...rest);
};
const originalFork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (...args) => {
  const child = originalFork(...args);
  utilities++; report(`UTILITY:${utilities}`);
  child.on('message', message => {
    if (message?.tipo === 'intake-cut-ack') report('CUT_ACK');
    if (message?.tipo === 'shutdown-recibo' && message.motivo === 'manutencao') report('MAINT_RECEIPT');
    if (message?.tipo === 'pronto') report(`READY:${utilities}`);
  });
  child.once('exit', code => report(`UTILITY_EXIT:${code}`));
  return child;
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const result = originalLoad.apply(this, arguments);
  if (request !== './maintenance-controller.cjs' || !parent?.filename.endsWith('desktop\\main.cjs')) return result;
  return { ...result, criarControladorManutencao(options) {
    const controller = result.criarControladorManutencao(options);
    controllers++;
    if (controllers === 1) setImmediate(async () => {
      try {
        const handle = await controller.beginMaintenance({ opId:randomUUID(), kind:'notetaker-delete' });
        report('LEASE');
        const receipt = await controller.endMaintenance(handle);
        report(`FINISHED:${receipt.outcome}`);
        report(`TOTALS:${windows}:${utilities}:${webLoads}`);
        app.quit();
      } catch (error) {
        report(`ERROR:${error?.code || error?.message || error}`);
        app.quit();
      }
    });
    return controller;
  } };
};
require('../../desktop/main.cjs');

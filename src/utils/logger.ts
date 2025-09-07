import Logger from 'log4js';
const root = process.cwd();
console.log(root);

Logger.configure({
  appenders: {
    access: { type: "dateFile", filename: (root + "/data/logs/access.log"), keepFileExt: true, fileNameSep: '_', pattern: 'yyyy-MM-dd', alwaysIncludePattern: true },
    log: { type: "dateFile", filename: (root + "/data/logs/info.log"), keepFileExt: true, fileNameSep: '_', pattern: 'yyyy-MM-dd', alwaysIncludePattern: true },
    print: { type: "console" },
  },
  categories: { default: { appenders: ["print", "log"], level: "info" }, access: { appenders: ["access"], level: "all" } }
});

export default function getLogger(name: string) {
  return Logger.getLogger(name);
}
//  deps
const paths = require('path');
const async = require('async');

const _ = require('lodash');
const reduceDeep = require('deepdash/getReduceDeep')(_);

module.exports = class ConfigLoader {
    constructor(
        { hotReload = true, defaultConfig = {}, defaultsCustomizer = null } = { hotReload : true, defaultConfig : {}, defaultsCustomizer : null } )
    {
        this.current = {};

        this.hotReload          = hotReload;
        this.defaultConfig      = defaultConfig;
        this.defaultsCustomizer = defaultsCustomizer;
    }

    init(baseConfigPath, cb) {
        this.baseConfigPath = baseConfigPath;
        return this._reload(baseConfigPath, cb);
    }

    get() {
        return this.current;
    }

    _reload(baseConfigPath, cb) {
        let defaultConfig;
        if (_.isFunction(this.defaultConfig)) {
            defaultConfig = this.defaultConfig();
        } else if (_.isObject(this.defaultConfig)) {
            defaultConfig = this.defaultConfig;
        } else {
            defaultConfig = {};
        }

        //
        //  1 - Fetch base configuration from |baseConfigPath|
        //  2 - Merge with |defaultConfig|
        //  3 - Resolve any includes
        //  4 - Resolve @reference and @environment
        //  5 - Perform any validation
        //
        async.waterfall(
            [
                (callback) => {
                    return this._loadConfigFile(baseConfigPath, callback);
                },
                (config, callback) => {
                    if (_.isFunction(this.defaultsCustomizer)) {
                        const stack = [];
                        const mergedConfig = _.mergeWith(
                            defaultConfig,
                            config,
                            (defaultVal, configVal, key, target, source) => {
                                var path;
                                while (true) {
                                    if (!stack.length) {
                                        stack.push({source, path : []});
                                    }

                                    const prev = stack[stack.length - 1];

                                    if (source === prev.source) {
                                        path = prev.path.concat(key);
                                        stack.push({source : configVal, path});
                                        break;
                                    }

                                    stack.pop();
                                }

                                path = path.join('.');
                                return this.defaultsCustomizer(defaultVal, configVal, key, path);
                            }
                        );

                        return callback(null, mergedConfig);
                    }

                    return callback(null, _.merge(defaultConfig, config));
                },
                (config, callback) => {
                    const configRoot = paths.dirname(baseConfigPath);
                    return this._resolveIncludes(configRoot, config, callback);
                },
                (config, callback) => {
                    config = this._resolveAtSpecs(config);
                    return callback(null, config);
                },
            ],
            (err, config) => {
                if (!err) {
                    this.current = config;
                }
                return cb(err);
            }
        );
    }

    _convertTo(value, type) {
        switch (type) {
            case 'bool' :
            case 'boolean' :
                value = 'true' === value.toLowerCase();
                break;

            case 'number' :
                {
                    const num = parseInt(value);
                    if (!isNaN(num)) {
                        value = num;
                    }
                }
                break;

            case 'object' :
                try {
                    value = JSON.parse(value);
                } catch(e) { }
                break;

            case 'date' :
            case 'time' :
            case 'datetime' :
            case 'timestamp' :
                {
                    const m = moment(value);
                    if (m.isValid()) {
                        value = m;
                    }
                }
                break;

            case 'regex' :
                //	:TODO: What flags to use, etc.?
                break;
        }

        return value;
    }

    _resolveEnvironmentVariable(spec) {
        const [prefix, varName, type, array] = spec.split(':');
        if (!varName) {
            return;
        }

        let value = process.env[varName];
        if (!value) {
            return;
        }

        if ('array' === array) {
            value = value.split(',').map(v => this._convertTo(v, type));
        } else {
            value = this._convertTo(value, type);
        }

        return value;
    }

    _loadConfigFile(filePath, cb) {
        const ConfigCache = require('./config_cache');

        const options = {
            filePath,
            hotReload   : this.hotReload,
            callback    : this._configFileChanged.bind(this),
        };

        ConfigCache.getConfigWithOptions(options, (err, config) => {
            return cb(err, config);
        });
    }

    _configFileChanged({fileName, fileRoot, configCache}) {
        const reCachedPath = paths.join(fileRoot, fileName);
        configCache.getConfig(reCachedPath, (err, config) => {
            if (err) {
                return console.stdout(`Configuration ${reCachedPath} is invalid: ${err.message}`); //  eslint-disable-line no-console
            }

            if (this.configPaths.includes(reCachedPath)) {
                this._reload(this.baseConfigPath, err => {
                    if (!err) {
                        const Events = require('./events.js');
                        Events.emit(Events.getSystemEvents().ConfigChanged);
                    }
                });
            }
        });
    }

    _resolveIncludes(configRoot, config, cb) {
        if (!Array.isArray(config.includes)) {
            return cb(null, config);
        }

        //  If a included file is changed, we need to re-cache, so this
        //  must be tracked...
        const includePaths = config.includes.map(inc => paths.join(configRoot, inc));
        async.eachSeries(includePaths, (includePath, nextIncludePath) => {
            this._loadConfigFile(includePath, (err, includedConfig) => {
                if (err) {
                    return nextIncludePath(err);
                }

                _.defaultsDeep(config, includedConfig);
                return nextIncludePath(null);
            });
        },
        err => {
            this.configPaths = [ this.baseConfigPath, ...includePaths ];
            return cb(err, config);
        });
    }

    _resolveAtSpecs(config) {
        //  :TODO: mapValuesDeep may be better here
        return reduceDeep(
            config,
            (acc, value, key, parent, ctx) => {
                //	resolve self references; there may be a better way...
                if (_.isString(value) && '@' === value.charAt(0)) {
                    if (value.startsWith('@reference:')) {
                        value = value.slice(11);
                        const ref = _.get(acc, value);
                        if (ref) {
                            _.set(acc, ctx.path, ref);
                        }
                    } else if (value.startsWith('@environment:')) {
                        value = this._resolveEnvironmentVariable(value);
                        if (!_.isUndefined(value)) {
                            _.set(acc, ctx.path, value);
                        }
                    }
                }
                return acc;
            }
        );
    }
};

/*!
 * Multi - Redis
 * Copyright(c) 2012 dead_horse <dead_horse@qq.com>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */
var redis = require('redis');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var commands = require('./commands');

/**
 * create mredis error
 * @param {String|Error} msg
 * @return {Error}
 */
function mError(msg) {
  if (msg instanceof Error) {
    msg.name = 'MRedis' + msg.name;
    return msg;
  }
  var err = new Error(msg);
  err.name = 'MRedisError';
  return err;
}

/**
 * Initialize MutiRedis with the given `options`.
 *
 * @param {Object} options
 * @api public
 */
function MultiRedis(options) {
  EventEmitter.call(this);
  options = options || {};
  if (options.server) {
    options.host = [];
    options.port = [];
    if (typeof options.server === 'string') {
      var stemp = options.server.split(':');
      options.host.push(stemp[0]);
      options.port.push(stemp[1]);
    } else {
      if (options.server instanceof Array) {
        for (var i=0, len=options.server.length; i!=len; ++i) {
          var stemp = options.server[i].split(':');
          options.host.push(stemp[0]);
          options.port.push(stemp[1]);
        }
      }
    }
  } else {
    options.host = options.host || ['127.0.0.1'];
    options.port = options.port || [6379];
    if (!(options.host instanceof Array)) {
      options.host = [options.host];
      options.port = options.port && [options.port];
      options.socket = options.socket && [options.socket];
    }
  }
  this.debug = options.debug;
  this.clients = [];
  // add for timeout in `_ping`
  this.timeouts = [];
  this.timers = [];
  this.total = options.port.length;
  this.alive = 0;
  this.index = 0;
  this.speedFirst = options.speedFirst;
  this.pingInterval = options.pingInterval || 3000;
  this.reqTimeout = options.reqTimeout || 3000;
  //create clients and bind event
  for (var i=0, len=options.host.length; i!=len; ++i) {
    var client = redis.createClient(options.port[i] || options.socket[i], options.host[i], options);
    if(this.debug) {
      console.log("%s: Redis connection to %s:%d",Date(), client.host, client.port);
    }   
    this.clients.push(client);
    ++this.alive;
    var self = this;
    (function(client) {
      //when connect end
      client.on('end', function() {
        for(var i=0, len=self.total; i!=len; ++i) {
          if(self.clients[i] === client) {
            if(self.debug) {
              console.log("%s: Redis disconnect to %s:%d", Date(), client.host, client.port);
            }
            --self.alive;
            self.clients[i] = null;
            //if last client down
            if(self.alive === 0) {
              var err = new Error('All servers are down.');
              err.name = 'MredisDeadError';
              self.emit('error', err);
            }
            //reping
            self._ping();
            break;
          }
        }
        process.nextTick(function() {
          self.emit('end', client);
        });
      });
      //when error
      client.on('error', function(err) {
        var alive = false;
        for (var i=0, len=self.total; i!=len; ++i) {
          if (client.port === options.port[i] && client.host === options.host[i]) {
            if (self.clients[i]) {
              alive = true;
            }
            break;
          }
        }
        if (alive && err.message 
          && err.message.indexOf('connect ECONNREFUSED') < 0
          && err.message.indexOf('Ready check failed') < 0) {
          process.nextTick(function() {
            self.emit('redisError', client, err);
          });
        }
      });
      //when connect
      client.on("connect", function() {
        // set client role
        self.setRole(client, function(){
          var index = 0;
          for(var i=0, len=self.total; i!=len; ++i) {
            if(client.port === options.port[i] && client.host === options.host[i]) {
              process.nextTick(function() {
                self.emit('connect', client);
              });
              index = i; break;
            }
          }
          if(self.clients[index]) {
            self.timeouts[index] = 0;
            return;
          }
          //if reconnect
          self.clients[index] = client;
          self.timeouts[index] = 0;
          ++self.alive;
          self._ping();
          if(self.debug) {
            console.log("%s: Redis connection to %s:%d",Date(), client.host, client.port);
          }
          process.nextTick(function() {
            self.emit('connect', client);
          });
        });
      });
    }) (client);
  }
  //ping each server to test the delay and timeout
  this._doPing();
}

util.inherits(MultiRedis, EventEmitter);

/**
 * change arguments to array
 * @param  {[type]} args [description]
 * @return {[type]}
 */
var toArray = function(args) {
  var arr = [];
  for (var i=0, len=args.length; i<len; ++i) {
    arr[i] = args[i];
  }
  return arr;
}
/**
 * get an alive server.
 */
MultiRedis.prototype._getAliveClient = function() {
  for(var i=0, len=this.total; i!=len; ++i) {
    if(this.clients[i]){
      return i;
    }
  }
  return -1;
}

commands.getCmds.forEach(function(command) {
  MultiRedis.prototype[command] = function() {
    var index = this._getIndex();
    var client = this.clients[index];
    var callback = arguments[arguments.length-1];
    if (!client) {
      index = this._getAliveClient();
      if (index < 0) {
        // all server down, an error will thow by event 'end'
        typeof callback === 'function' && callback(new Error('All servers are down.'));
        return;
      }
      client = this.clients[index];
    }
    var arrArg = toArray(arguments);
    var lastArgType = typeof arrArg[arrArg.length - 1];
    if (lastArgType === 'function') {
      var fn = arrArg.pop();
      var self = this;
      var haveCalled = false;
      
      var timer = setTimeout(function() {
        !haveCalled && fn(mError('request timeout.'));
        haveCalled = true;
        if (++self.timeouts[index] >= 3 && self.clients[index]) {
          self.clients[index].stream.end();
          self.clients[index].stream.emit('end');
        }
      }, self.reqTimeout);

      var cb = function(err) {
        if (haveCalled) {
          return;
        }
        haveCalled =  true;
        clearTimeout(timer);
        self.timeouts[index] = 0;
        arguments[0] = (arguments[0] instanceof Error)? mError(arguments[0]) : arguments[0];
        fn.apply(null, toArray(arguments)); 
      }
      arrArg.push(cb);
    }
    client[command].apply(client, arrArg);
    if (this.debug) {
      console.log("Command %s on redis server %s:%d", command, client.host, client.port);
    }
  };
  MultiRedis.prototype[command.toUpperCase()] = MultiRedis.prototype[command];
});

commands.setCmds.forEach(function(command) {
  MultiRedis.prototype[command] = function() {
    var called = 0;
    var callback = arguments[arguments.length-1];
    var lastArgType = typeof callback;
    var haveCalled = false;
    var timer;
    if (this.debug) {
      console.log("Command %s on multi redis servers", command);
    }
    var arrArg = toArray(arguments);
    if (lastArgType==='function') {
      var fn = arrArg.pop();
      var self = this;
      var cbArg;
      //make sure only call cb once
      timer = setTimeout(function() {
        !haveCalled && fn(mError('request timeout.'));
        haveCalled =  true;
      }, self.reqTimeout);
      var cb = function(err) {
        ++called;
        if (err) {
          if (!haveCalled) {
            haveCalled = true;
            arguments[0] = mError(err);
            return fn.apply(null, arguments);
          }
        }
        if (called === self.total && !haveCalled) {
          haveCalled = true;
          fn.apply(null, arguments);
        }
      }
      arrArg.push(cb);
    }
    var doCmd = false;
    var haveSlave = false;
    var slaveClients = [];

    for(var i = 0, len = this.total; i != len; ++i) {
      var client = this.clients[i];
      if(!client) {
        ++called;
        continue;
      }else if('slave' === client.role){
        ++called;
        haveSlave = true;
        slaveClients.push(client);
        continue;
      }

      doCmd = true;
      client[command].apply(client, arrArg);
    }

    if(!doCmd && haveSlave){
      var client = slaveClients.pop();
      doCmd = true;
      --called;// bease ++ before check
      console.log('slave do write, host: '+client.host+', port: ',client.port);
      client[command].apply(client, arrArg);
      self.slaveof(client, 'no', 'one');

      if(slaveClients.length > 0){
        self.changeSlaveOf(slaveClients, client.host, client.port);
      }
    }

    if(!doCmd && typeof callback === 'function') {
      !haveCalled && callback(mError('All servers are down.'));
      haveCalled = true;
      clearTimeout(timer);
    }
  };
  MultiRedis.prototype[command.toUpperCase()] = MultiRedis.prototype[command];
})
/**
 * end all the redis server
 * @api public
 */
MultiRedis.prototype.end = function() {
  for (var i=0, len=this.total; i!=len; ++i) {
    var client = this.clients[i];
    if(client) {
      client.end();
      client = null;
    }
  }
  this.alive = 0;  
  if (this.debug) {
    console.log('All redis server end');
  }
}
/**
 * return which server to read
 * @api private
 */
MultiRedis.prototype._getIndex = function() {
  return this.speedFirst ?
         this.index : this.index++ % this.clients.length;
}
/**
 * test speed of each server
 * @return {[type]}
 */
MultiRedis.prototype._doPing = function() {
  var self = this;
  self._ping();
  self._pingTimer = setInterval(function(){
    self._ping.call(self);
  }, self.pingInterval);
}

MultiRedis.prototype._ping = function() {
  var self = this;
  var min = 100000000;
  var index = 0;
  var called = 0;

  for (var i=0, len=self.total; i!=len; ++i) {
    (function(i) {
      var start = new Date().getTime();
      var client = self.clients[i];
      if(!client) {
        if(++called === self.total && self.speedFirst) {
          self.index = index;
        }
        return;
      }

      //if more than 3 times timeout, end this client
      var timer = setTimeout(function() {
        if (++self.timeouts[i] >= 3 && self.clients[i]) {
          self.clients[i].stream.end();
          self.clients[i].stream.emit('end');
        }
      }, self.reqTimeout);

      client.ping(function(message) {
        clearTimeout(timer);
        self.timeouts[i] = 0;
        var interval = new Date().getTime() - start;
        if(interval < min) {
          min = interval;
          index = i;
        }
        if(++called === self.total && self.speedFirst) {
          self.index = index;
        }
      })
    })(i);
  };
}

MultiRedis.prototype.getClient = function(index) {                                                                                                                   
  index = index === undefined ? 0 : index;                                                                                                                           
  return this.clients[index];                                                                                                                                        
};

/**
 * get an instance of multi redis
 * or you can use createClient(options), write port and host in the options
 * @param  {array | string} port    redis server port
 * @param  {array | string} host    redis server host
 * @param  {object} options options
 * @api public
 */
MultiRedis.createClient = function(port, host, options) {
  if(typeof port === 'number' || Array.isArray(port)) {
    options = options || {};
    options.port = port;
    options.host = host;
  } else {
    options = port;
  }
  return new MultiRedis(options);
}

MultiRedis.prototype.setRole = function(client, cb){
  var self = this;
  this.getRole(client, function(role){
    if('slave' === role){
      setTimeout(cb, 10*1000);// slave sync time
    }else{
      cb();
    }
  });
};

MultiRedis.prototype.getRole = function(client, cb){
  client.info('replication', function(err, status){
    var arr = status.split('\r\n');
    if(arr.length > 0){
      var roleArr = arr[1].split(':');
      if(roleArr.length === 2){
        //console.log('role: ',roleArr[1]);
        client.role = roleArr[1];
        cb(roleArr[1]);
      }else{
        cb();
      }
    }else{
      cb();
    }
  });
};

MultiRedis.prototype.slaveof = function(client, host, port){
  client.slaveof(host, port, function(err, status){
    
  });
};

MultiRedis.prototype.changeSlaveOf = function(slaveClients, host, port){
  var self = this;
  slaveClients.forEach(function(client){
    self.slaveof(client, host, port);
  });
};
module.exports = MultiRedis;

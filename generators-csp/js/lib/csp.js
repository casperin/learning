(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
"use strict";

var buffers = require("./impl/buffers");
var channels = require("./impl/channels");
var select = require("./impl/select");
var process = require("./impl/process");
var timers = require("./impl/timers");

function spawn(gen, creator) {
  var ch = channels.chan(buffers.fixed(1));
  (new process.Process(gen, function(value) {
    if (value === channels.CLOSED) {
      ch.close();
    } else {
      process.put_then_callback(ch, value, function(ok) {
        ch.close();
      });
    }
  }, creator)).run();
  return ch;
};

function go(f, args) {
  args = args || [];

  var gen = f.apply(null, args);
  return spawn(gen, f);
};

function chan(bufferOrNumber, xform, exHandler) {
  var buf;
  if (bufferOrNumber === 0) {
    bufferOrNumber = null;
  }
  if (typeof bufferOrNumber === "number") {
    buf = buffers.fixed(bufferOrNumber);
  } else {
    buf = bufferOrNumber;
  }
  return channels.chan(buf, xform, exHandler);
};

function promiseChan(xform, exHandler){
    return chan(buffers.promise(), xform, exHandler);
};


module.exports = {
  buffers: {
    fixed: buffers.fixed,
    dropping: buffers.dropping,
    sliding: buffers.sliding,
    promise: buffers.promise
  },

  spawn: spawn,
  go: go,
  chan: chan,
  promiseChan: promiseChan,
  DEFAULT: select.DEFAULT,
  CLOSED: channels.CLOSED,

  put: process.put,
  take: process.take,
  sleep: process.sleep,
  alts: process.alts,
  putAsync: process.put_then_callback,
  takeAsync: process.take_then_callback,

  timeout: timers.timeout
};

},{"./impl/buffers":5,"./impl/channels":6,"./impl/process":8,"./impl/select":9,"./impl/timers":10}],2:[function(require,module,exports){
"use strict";

var csp = require("./csp.core");
var operations = require("./csp.operations");
var pipeline = require('./csp.pipeline');

csp.operations = operations;
csp.operations.pipeline = pipeline.pipeline;
csp.operations.pipelineAsync = pipeline.pipelineAsync;

module.exports = csp;

},{"./csp.core":1,"./csp.operations":3,"./csp.pipeline":4}],3:[function(require,module,exports){
"use strict";

var Box = require("./impl/channels").Box;

var csp = require("./csp.core"),
    go = csp.go,
    take = csp.take,
    put = csp.put,
    takeAsync = csp.takeAsync,
    putAsync = csp.putAsync,
    alts = csp.alts,
    chan = csp.chan,
    CLOSED = csp.CLOSED;


function mapFrom(f, ch) {
  return {
    is_closed: function() {
      return ch.is_closed();
    },
    close: function() {
      ch.close();
    },
    _put: function(value, handler) {
      return ch._put(value, handler);
    },
    _take: function(handler) {
      var result = ch._take({
        is_active: function() {
          return handler.is_active();
        },
        commit: function() {
          var take_cb = handler.commit();
          return function(value) {
            return take_cb(value === CLOSED ? CLOSED : f(value));
          };
        }
      });
      if (result) {
        var value = result.value;
        return new Box(value === CLOSED ? CLOSED : f(value));
      } else {
        return null;
      }
    }
  };
}

function mapInto(f, ch) {
  return {
    is_closed: function() {
      return ch.is_closed();
    },
    close: function() {
      ch.close();
    },
    _put: function(value, handler) {
      return ch._put(f(value), handler);
    },
    _take: function(handler) {
      return ch._take(handler);
    }
  };
}

function filterFrom(p, ch, bufferOrN) {
  var out = chan(bufferOrN);
  go(function*() {
    while (true) {
      var value = yield take(ch);
      if (value === CLOSED) {
        out.close();
        break;
      }
      if (p(value)) {
        yield put(out, value);
      }
    }
  });
  return out;
}

function filterInto(p, ch) {
  return {
    is_closed: function() {
      return ch.is_closed();
    },
    close: function() {
      ch.close();
    },
    _put: function(value, handler) {
      if (p(value)) {
        return ch._put(value, handler);
      } else {
        return new Box(!ch.is_closed());
      }
    },
    _take: function(handler) {
      return ch._take(handler);
    }
  };
}

function removeFrom(p, ch) {
  return filterFrom(function(value) {
    return !p(value);
  }, ch);
}

function removeInto(p, ch) {
  return filterInto(function(value) {
    return !p(value);
  }, ch);
}

function* mapcat(f, src, dst) {
  while (true) {
    var value = yield take(src);
    if (value === CLOSED) {
      dst.close();
      break;
    } else {
      var seq = f(value);
      var length = seq.length;
      for (var i = 0; i < length; i++) {
        yield put(dst, seq[i]);
      }
      if (dst.is_closed()) {
        break;
      }
    }
  }
}

function mapcatFrom(f, ch, bufferOrN) {
  var out = chan(bufferOrN);
  go(mapcat, [f, ch, out]);
  return out;
}

function mapcatInto(f, ch, bufferOrN) {
  var src = chan(bufferOrN);
  go(mapcat, [f, src, ch]);
  return src;
}

function pipe(src, dst, keepOpen) {
  go(function*() {
    while (true) {
      var value = yield take(src);
      if (value === CLOSED) {
        if (!keepOpen) {
          dst.close();
        }
        break;
      }
      if (!(yield put(dst, value))) {
        break;
      }
    }
  });
  return dst;
}

function split(p, ch, trueBufferOrN, falseBufferOrN) {
  var tch = chan(trueBufferOrN);
  var fch = chan(falseBufferOrN);
  go(function*() {
    while (true) {
      var value = yield take(ch);
      if (value === CLOSED) {
        tch.close();
        fch.close();
        break;
      }
      yield put(p(value) ? tch : fch, value);
    }
  });
  return [tch, fch];
}

function reduce(f, init, ch) {
  return go(function*() {
    var result = init;
    while (true) {
      var value = yield take(ch);
      if (value === CLOSED) {
        return result;
      } else {
        result = f(result, value);
      }
    }
  }, [], true);
}

function onto(ch, coll, keepOpen) {
  return go(function*() {
    var length = coll.length;
    // FIX: Should be a generic looping interface (for...in?)
    for (var i = 0; i < length; i++) {
      yield put(ch, coll[i]);
    }
    if (!keepOpen) {
      ch.close();
    }
  });
}

// TODO: Bounded?
function fromColl(coll) {
  var ch = chan(coll.length);
  onto(ch, coll);
  return ch;
}

function map(f, chs, bufferOrN) {
  var out = chan(bufferOrN);
  var length = chs.length;
  // Array holding 1 round of values
  var values = new Array(length);
  // TODO: Not sure why we need a size-1 buffer here
  var dchan = chan(1);
  // How many more items this round
  var dcount;
  // put callbacks for each channel
  var dcallbacks = new Array(length);
  for (var i = 0; i < length; i ++) {
    dcallbacks[i] = (function(i) {
      return function(value) {
        values[i] = value;
        dcount --;
        if (dcount === 0) {
          putAsync(dchan, values.slice(0));
        }
      };
    }(i));
  }
  go(function*() {
    while (true) {
      dcount = length;
      // We could just launch n goroutines here, but for effciency we
      // don't
      for (var i = 0; i < length; i ++) {
        try {
          takeAsync(chs[i], dcallbacks[i]);
        } catch (e) {
          // FIX: Hmm why catching here?
          dcount --;
        }
      }
      var values = yield take(dchan);
      for (i = 0; i < length; i ++) {
        if (values[i] === CLOSED) {
          out.close();
          return;
        }
      }
      yield put(out, f.apply(null, values));
    }
  });
  return out;
}

function merge(chs, bufferOrN) {
  var out = chan(bufferOrN);
  var actives = chs.slice(0);
  go(function*() {
    while (true) {
      if (actives.length === 0) {
        break;
      }
      var r = yield alts(actives);
      var value = r.value;
      if (value === CLOSED) {
        // Remove closed channel
        var i = actives.indexOf(r.channel);
        actives.splice(i, 1);
        continue;
      }
      yield put(out, value);
    }
    out.close();
  });
  return out;
}

function into(coll, ch) {
  var result = coll.slice(0);
  return reduce(function(result, item) {
    result.push(item);
    return result;
  }, result, ch);
}

function takeN(n, ch, bufferOrN) {
  var out = chan(bufferOrN);
  go(function*() {
    for (var i = 0; i < n; i ++) {
      var value = yield take(ch);
      if (value === CLOSED) {
        break;
      }
      yield put(out, value);
    }
    out.close();
  });
  return out;
}

var NOTHING = {};

function unique(ch, bufferOrN) {
  var out = chan(bufferOrN);
  var last = NOTHING;
  go(function*() {
    while (true) {
      var value = yield take(ch);
      if (value === CLOSED) {
        break;
      }
      if (value === last) {
        continue;
      }
      last = value;
      yield put(out, value);
    }
    out.close();
  });
  return out;
}

function partitionBy(f, ch, bufferOrN) {
  var out = chan(bufferOrN);
  var part = [];
  var last = NOTHING;
  go(function*() {
    while (true) {
      var value = yield take(ch);
      if (value === CLOSED) {
        if (part.length > 0) {
          yield put(out, part);
        }
        out.close();
        break;
      } else {
        var newItem = f(value);
        if (newItem === last || last === NOTHING) {
          part.push(value);
        } else {
          yield put(out, part);
          part = [value];
        }
        last = newItem;
      }
    }
  });
  return out;
}

function partition(n, ch, bufferOrN) {
  var out = chan(bufferOrN);
  go(function*() {
    while (true) {
      var part = new Array(n);
      for (var i = 0; i < n; i++) {
        var value = yield take(ch);
        if (value === CLOSED) {
          if (i > 0) {
            yield put(out, part.slice(0, i));
          }
          out.close();
          return;
        }
        part[i] = value;
      }
      yield put(out, part);
    }
  });
  return out;
}

// For channel identification
var genId = (function() {
  var i = 0;
  return function() {
    i ++;
    return "" + i;
  };
})();

var ID_ATTR = "__csp_channel_id";

// TODO: Do we need to check with hasOwnProperty?
function len(obj) {
  var count = 0;
  for (var p in obj) {
    count ++;
  }
  return count;
}

function chanId(ch) {
  var id = ch[ID_ATTR];
  if (id === undefined) {
    id = ch[ID_ATTR] = genId();
  }
  return id;
}

var Mult = function(ch) {
  this.taps = {};
  this.ch = ch;
};

var Tap = function(channel, keepOpen) {
  this.channel = channel;
  this.keepOpen = keepOpen;
};

Mult.prototype.muxch = function() {
  return this.ch;
};

Mult.prototype.tap = function(ch, keepOpen) {
  var id = chanId(ch);
  this.taps[id] = new Tap(ch, keepOpen);
};

Mult.prototype.untap = function(ch) {
  delete this.taps[chanId(ch)];
};

Mult.prototype.untapAll = function() {
  this.taps = {};
};

function mult(ch) {
  var m = new Mult(ch);
  var dchan = chan(1);
  var dcount;
  function makeDoneCallback(tap) {
    return function(stillOpen) {
      dcount --;
      if (dcount === 0) {
        putAsync(dchan, true);
      }
      if (!stillOpen) {
        m.untap(tap.channel);
      }
    };
  }
  go(function*() {
    while (true) {
      var value = yield take(ch);
      var id, t;
      var taps = m.taps;
      if (value === CLOSED) {
        for (id in taps) {
          t = taps[id];
          if (!t.keepOpen) {
            t.channel.close();
          }
        }
        // TODO: Is this necessary?
        m.untapAll();
        break;
      }
      dcount = len(taps);
      // XXX: This is because putAsync can actually call back
      // immediately. Fix that
      var initDcount = dcount;
      // Put value on tapping channels...
      for (id in taps) {
        t = taps[id];
        putAsync(t.channel, value, makeDoneCallback(t));
      }
      // ... waiting for all puts to complete
      if (initDcount > 0) {
        yield take(dchan);
      }
    }
  });
  return m;
}

mult.tap = function tap(m, ch, keepOpen) {
  m.tap(ch, keepOpen);
  return ch;
};

mult.untap = function untap(m, ch) {
  m.untap(ch);
};

mult.untapAll = function untapAll(m) {
  m.untapAll();
};

var Mix = function(ch) {
  this.ch = ch;
  this.stateMap = {};
  this.change = chan();
  this.soloMode = mix.MUTE;
};

Mix.prototype._changed = function() {
  putAsync(this.change, true);
};

Mix.prototype._getAllState = function() {
  var allState = {};
  var stateMap = this.stateMap;
  var solos = [];
  var mutes = [];
  var pauses = [];
  var reads;
  for (var id in stateMap) {
    var chanData = stateMap[id];
    var state = chanData.state;
    var channel = chanData.channel;
    if (state[mix.SOLO]) {
      solos.push(channel);
    }
    // TODO
    if (state[mix.MUTE]) {
      mutes.push(channel);
    }
    if (state[mix.PAUSE]) {
      pauses.push(channel);
    }
  }
  var i, n;
  if (this.soloMode === mix.PAUSE && solos.length > 0) {
    n = solos.length;
    reads = new Array(n + 1);
    for (i = 0; i < n; i++) {
      reads[i] = solos[i];
    }
    reads[n] = this.change;
  } else {
    reads = [];
    for (id in stateMap) {
      chanData = stateMap[id];
      channel = chanData.channel;
      if (pauses.indexOf(channel) < 0) {
        reads.push(channel);
      }
    }
    reads.push(this.change);
  }

  return {
    solos: solos,
    mutes: mutes,
    reads: reads
  };
};

Mix.prototype.admix = function(ch) {
  this.stateMap[chanId(ch)] = {
    channel: ch,
    state: {}
  };
  this._changed();
};

Mix.prototype.unmix = function(ch) {
  delete this.stateMap[chanId(ch)];
  this._changed();
};

Mix.prototype.unmixAll = function() {
  this.stateMap = {};
  this._changed();
};

Mix.prototype.toggle = function(updateStateList) {
  // [[ch1, {}], [ch2, {solo: true}]];
  var length = updateStateList.length;
  for (var i = 0; i < length; i++) {
    var ch = updateStateList[i][0];
    var id = chanId(ch);
    var updateState = updateStateList[i][1];
    var chanData = this.stateMap[id];
    if (!chanData) {
      chanData = this.stateMap[id] = {
        channel: ch,
        state: {}
      };
    }
    for (var mode in updateState) {
      chanData.state[mode] = updateState[mode];
    }
  }
  this._changed();
};

Mix.prototype.setSoloMode = function(mode) {
  if (VALID_SOLO_MODES.indexOf(mode) < 0) {
    throw new Error("Mode must be one of: ", VALID_SOLO_MODES.join(", "));
  }
  this.soloMode = mode;
  this._changed();
};

function mix(out) {
  var m = new Mix(out);
  go(function*() {
    var state = m._getAllState();
    while (true) {
      var result = yield alts(state.reads);
      var value = result.value;
      var channel = result.channel;
      if (value === CLOSED) {
        delete m.stateMap[chanId(channel)];
        state = m._getAllState();
        continue;
      }
      if (channel === m.change) {
        state = m._getAllState();
        continue;
      }
      var solos = state.solos;
      if (solos.indexOf(channel) > -1 ||
          (solos.length === 0 && !(state.mutes.indexOf(channel) > -1))) {
        var stillOpen = yield put(out, value);
        if (!stillOpen) {
          break;
        }
      }
    }
  });
  return m;
}

mix.MUTE = "mute";
mix.PAUSE = "pause";
mix.SOLO = "solo";
var VALID_SOLO_MODES = [mix.MUTE, mix.PAUSE];

mix.add = function admix(m, ch) {
  m.admix(ch);
};

mix.remove = function unmix(m, ch) {
  m.unmix(ch);
};

mix.removeAll = function unmixAll(m) {
  m.unmixAll();
};

mix.toggle = function toggle(m, updateStateList) {
  m.toggle(updateStateList);
};

mix.setSoloMode = function setSoloMode(m, mode) {
  m.setSoloMode(mode);
};

function constantlyNull() {
  return null;
}

var Pub = function(ch, topicFn, bufferFn) {
  this.ch = ch;
  this.topicFn = topicFn;
  this.bufferFn = bufferFn;
  this.mults = {};
};

Pub.prototype._ensureMult = function(topic) {
  var m = this.mults[topic];
  var bufferFn = this.bufferFn;
  if (!m) {
    m = this.mults[topic] = mult(chan(bufferFn(topic)));
  }
  return m;
};

Pub.prototype.sub = function(topic, ch, keepOpen) {
  var m = this._ensureMult(topic);
  return mult.tap(m, ch, keepOpen);
};

Pub.prototype.unsub = function(topic, ch) {
  var m = this.mults[topic];
  if (m) {
    mult.untap(m, ch);
  }
};

Pub.prototype.unsubAll = function(topic) {
  if (topic === undefined) {
    this.mults = {};
  } else {
    delete this.mults[topic];
  }
};

function pub(ch, topicFn, bufferFn) {
  bufferFn = bufferFn || constantlyNull;
  var p = new Pub(ch, topicFn, bufferFn);
  go(function*() {
    while (true) {
      var value = yield take(ch);
      var mults = p.mults;
      var topic;
      if (value === CLOSED) {
        for (topic in mults) {
          mults[topic].muxch().close();
        }
        break;
      }
      // TODO: Somehow ensure/document that this must return a string
      // (otherwise use proper (hash)maps)
      topic = topicFn(value);
      var m = mults[topic];
      if (m) {
        var stillOpen = yield put(m.muxch(), value);
        if (!stillOpen) {
          delete mults[topic];
        }
      }
    }
  });
  return p;
}

pub.sub = function sub(p, topic, ch, keepOpen) {
  return p.sub(topic, ch, keepOpen);
};

pub.unsub = function unsub(p, topic, ch) {
  p.unsub(topic, ch);
};

pub.unsubAll = function unsubAll(p, topic) {
  p.unsubAll(topic);
};

module.exports = {
  mapFrom: mapFrom,
  mapInto: mapInto,
  filterFrom: filterFrom,
  filterInto: filterInto,
  removeFrom: removeFrom,
  removeInto: removeInto,
  mapcatFrom: mapcatFrom,
  mapcatInto: mapcatInto,

  pipe: pipe,
  split: split,
  reduce: reduce,
  onto: onto,
  fromColl: fromColl,

  map: map,
  merge: merge,
  into: into,
  take: takeN,
  unique: unique,
  partition: partition,
  partitionBy: partitionBy,

  mult: mult,
  mix: mix,
  pub: pub
};


// Possible "fluid" interfaces:

// thread(
//   [fromColl, [1, 2, 3, 4]],
//   [mapFrom, inc],
//   [into, []]
// )

// thread(
//   [fromColl, [1, 2, 3, 4]],
//   [mapFrom, inc, _],
//   [into, [], _]
// )

// wrap()
//   .fromColl([1, 2, 3, 4])
//   .mapFrom(inc)
//   .into([])
//   .unwrap();

},{"./csp.core":1,"./impl/channels":6}],4:[function(require,module,exports){
"use strict";

var csp = require('./csp.core');

function pipelineInternal(n, to, from, close, taskFn) {
  if (n <= 0) {
    throw new Error('n must be positive');
  }

  var jobs = csp.chan(n);
  var results = csp.chan(n);

  for(var _ = 0; _ < n; _++) {
    csp.go(function* (taskFn, jobs, results) {
      while (true) {
        var job = yield csp.take(jobs);

        if (!taskFn(job)) {
          results.close();
          break;
        }
      }
    }, [taskFn, jobs, results]);
  }

  csp.go(function* (jobs, from, results) {
    while (true) {
      var v = yield csp.take(from);
      if (v === csp.CLOSED) {
        jobs.close();
        break;
      } else {
        var p = csp.chan(1);

        yield csp.put(jobs, [v, p]);
        yield csp.put(results, p);
      }
    }
  }, [jobs, from, results]);

  csp.go(function* (results, close, to) {
    while(true) {
      var p = yield csp.take(results);
      if (p === csp.CLOSED) {
        if (close) {
          to.close();
        }
        break;
      } else {
        var res = yield csp.take(p);
        while(true) {
          var v = yield csp.take(res);
          if (v !== csp.CLOSED) {
            yield csp.put(to, v);
          } else {
            break;
          }
        }
      }
    }
  }, [results, close, to]);

  return to;
}

function pipeline(to, xf, from, keepOpen, exHandler) {

  function taskFn(job) {
    if (job === csp.CLOSED) {
      return null;
    } else {
      var v = job[0];
      var p = job[1];
      var res = csp.chan(1, xf, exHandler);

      csp.go(function* (res, v) {
        yield csp.put(res, v);
        res.close();
      }, [res, v]);

      csp.putAsync(p, res);

      return true;
    }
  }

  return pipelineInternal(1, to, from, !keepOpen, taskFn);
}

function pipelineAsync(n, to, af, from, keepOpen) {

  function taskFn(job) {
    if (job === csp.CLOSED) {
      return null;
    } else {
      var v = job[0];
      var p = job[1];
      var res = csp.chan(1);
      af(v, res);
      csp.putAsync(p, res);
      return true;
    }
  }

  return pipelineInternal(n, to, from, !keepOpen, taskFn);
}

module.exports = {
  pipeline: pipeline,
  pipelineAsync: pipelineAsync
};

},{"./csp.core":1}],5:[function(require,module,exports){
"use strict";

// TODO: Consider EmptyError & FullError to avoid redundant bound
// checks, to improve performance (may need benchmarks)

function acopy(src, src_start, dst, dst_start, length) {
  var count = 0;
  while (true) {
    if (count >= length) {
      break;
    }
    dst[dst_start + count] = src[src_start + count];
    count ++;
  }
}

function noop() {};

var EMPTY = {
  toString: function() {
    return "[object EMPTY]";
  }
};

var RingBuffer = function(head, tail, length, array) {
  this.length = length;
  this.array = array;
  this.head = head;
  this.tail = tail;
};

// Internal method, callers must do bound check
RingBuffer.prototype._unshift = function(item) {
  var array = this.array;
  var head = this.head;
  array[head] = item;
  this.head = (head + 1) % array.length;
  this.length ++;
};

RingBuffer.prototype._resize = function() {
  var array = this.array;
  var new_length = 2 * array.length;
  var new_array = new Array(new_length);
  var head = this.head;
  var tail = this.tail;
  var length = this.length;
  if (tail < head) {
    acopy(array, tail, new_array, 0, length);
    this.tail = 0;
    this.head = length;
    this.array = new_array;
  } else if (tail > head) {
    acopy(array, tail, new_array, 0, array.length - tail);
    acopy(array, 0, new_array, array.length - tail, head);
    this.tail = 0;
    this.head = length;
    this.array = new_array;
  } else if (tail === head) {
    this.tail = 0;
    this.head = 0;
    this.array = new_array;
  }
};

RingBuffer.prototype.unbounded_unshift = function(item) {
  if (this.length + 1 === this.array.length) {
    this._resize();
  }
  this._unshift(item);
};

RingBuffer.prototype.pop = function() {
  if (this.length === 0) {
    return EMPTY;
  }
  var array = this.array;
  var tail = this.tail;
  var item = array[tail];
  array[tail] = null;
  this.tail = (tail + 1) % array.length;
  this.length --;
  return item;
};

RingBuffer.prototype.cleanup = function(predicate) {
  var length = this.length;
  for (var i = 0; i < length; i++) {
    var item = this.pop();
    if (predicate(item)) {
      this._unshift(item);
    }
  }
};

var FixedBuffer = function(buf,  n) {
  this.buf = buf;
  this.n = n;
};

FixedBuffer.prototype.is_full = function() {
  return this.buf.length >= this.n;
};

FixedBuffer.prototype.remove = function() {
  return this.buf.pop();
};

FixedBuffer.prototype.add = function(item) {
  // Note that even though the underlying buffer may grow, "n" is
  // fixed so after overflowing the buffer is still considered full.
  this.buf.unbounded_unshift(item);
};

FixedBuffer.prototype.count = function() {
  return this.buf.length;
};

FixedBuffer.prototype.close = noop;

var DroppingBuffer = function(buf, n) {
  this.buf = buf;
  this.n = n;
};

DroppingBuffer.prototype.is_full = function() {
  return false;
};

DroppingBuffer.prototype.remove = function() {
  return this.buf.pop();
};

DroppingBuffer.prototype.add = function(item) {
  if (this.buf.length < this.n) {
    this.buf._unshift(item);
  }
};

DroppingBuffer.prototype.count = function() {
  return this.buf.length;
};

DroppingBuffer.prototype.close = noop;

var SlidingBuffer = function(buf, n) {
  this.buf = buf;
  this.n = n;
};

SlidingBuffer.prototype.is_full = function() {
  return false;
};

SlidingBuffer.prototype.remove = function() {
  return this.buf.pop();
};

SlidingBuffer.prototype.add = function(item) {
  if (this.buf.length === this.n) {
    this.buf.pop();
  }
  this.buf._unshift(item);
};

SlidingBuffer.prototype.count = function() {
  return this.buf.length;
};

SlidingBuffer.prototype.close = noop;

var PromiseBuffer = function PromiseBuffer() {
  this.val = EMPTY;
};

PromiseBuffer.prototype.count = function() {
  return (this.val === EMPTY) ? 0 : 1;
};

PromiseBuffer.prototype.add = function(item) {
  if (this.val === EMPTY) {
    this.val = item;
  }
};

PromiseBuffer.prototype.is_full = function() {
  return false;
};

PromiseBuffer.prototype.remove = function() {
  return this.val;
};

PromiseBuffer.prototype.close = function() {
  this.val = EMPTY;
};

var ring = exports.ring = function ring_buffer(n) {
  return new RingBuffer(0, 0, 0, new Array(n));
};

/**
 * Returns a buffer that is considered "full" when it reaches size n,
 * but still accepts additional items, effectively allow overflowing.
 * The overflowing behavior is useful for supporting "expanding"
 * transducers, where we want to check if a buffer is full before
 * running the transduced step function, while still allowing a
 * transduced step to expand into multiple "essence" steps.
 */
exports.fixed = function fixed_buffer(n) {
  return new FixedBuffer(ring(n), n);
};

exports.dropping = function dropping_buffer(n) {
  return new DroppingBuffer(ring(n), n);
};

exports.sliding = function sliding_buffer(n) {
  return new SlidingBuffer(ring(n), n);
};

exports.promise = function promise_buffer() {
  return new PromiseBuffer();
};

exports.EMPTY = EMPTY;

},{}],6:[function(require,module,exports){
"use strict";

var buffers = require("./buffers");
var dispatch = require("./dispatch");

var MAX_DIRTY = 64;
var MAX_QUEUE_SIZE = 1024;

var CLOSED = null;

var Box = function(value) {
  this.value = value;
};

var PutBox = function(handler, value) {
  this.handler = handler;
  this.value = value;
};

var Channel = function(takes, puts, buf, xform) {
  this.buf = buf;
  this.xform = xform;
  this.takes = takes;
  this.puts = puts;

  this.dirty_takes = 0;
  this.dirty_puts = 0;
  this.closed = false;
};

function isReduced(v) {
  return v && v["@@transducer/reduced"];
}

function schedule(f, v) {
  dispatch.run(function() {
    f(v);
  });
}

Channel.prototype._put = function(value, handler) {
  if (value === CLOSED) {
    throw new Error("Cannot put CLOSED on a channel.");
  }

  // TODO: I'm not sure how this can happen, because the operations
  // are registered in 1 tick, and the only way for this to be inactive
  // is for a previous operation in the same alt to have returned
  // immediately, which would have short-circuited to prevent this to
  // be ever register anyway. The same thing goes for the active check
  // in "_take".
  if (!handler.is_active()) {
    return null;
  }

  if (this.closed) {
    handler.commit();
    return new Box(false);
  }

  var taker, callback;

  // Soak the value through the buffer first, even if there is a
  // pending taker. This way the step function has a chance to act on the
  // value.
  if (this.buf && !this.buf.is_full()) {
    handler.commit();
    var done = isReduced(this.xform["@@transducer/step"](this.buf, value));
    while (true) {
      if (this.buf.count() === 0) {
        break;
      }
      taker = this.takes.pop();
      if (taker === buffers.EMPTY) {
        break;
      }
      if (taker.is_active()) {
        value = this.buf.remove();
        callback = taker.commit();
        schedule(callback, value);
      }
    }
    if (done) {
      this.close();
    }
    return new Box(true);
  }

  // Either the buffer is full, in which case there won't be any
  // pending takes, or we don't have a buffer, in which case this loop
  // fulfills the first of them that is active (note that we don't
  // have to worry about transducers here since we require a buffer
  // for that).
  while (true) {
    taker = this.takes.pop();
    if (taker === buffers.EMPTY) {
      break;
    }
    if (taker.is_active()) {
      handler.commit();
      callback = taker.commit();
      schedule(callback, value);
      return new Box(true);
    }
  }

  // No buffer, full buffer, no pending takes. Queue this put now.
  if (this.dirty_puts > MAX_DIRTY) {
    this.puts.cleanup(function(putter) {
      return putter.handler.is_active();
    });
    this.dirty_puts = 0;
  } else {
    this.dirty_puts ++;
  }
  if (this.puts.length >= MAX_QUEUE_SIZE) {
    throw new Error("No more than " + MAX_QUEUE_SIZE + " pending puts are allowed on a single channel.");
  }
  this.puts.unbounded_unshift(new PutBox(handler, value));
  return null;
};

Channel.prototype._take = function(handler) {
  if (!handler.is_active()) {
    return null;
  }

  var putter, put_handler, callback, value;

  if (this.buf && this.buf.count() > 0) {
    handler.commit();
    value = this.buf.remove();
    // We need to check pending puts here, other wise they won't
    // be able to proceed until their number reaches MAX_DIRTY
    while (true) {
      if (this.buf.is_full()) {
        break;
      }
      putter = this.puts.pop();
      if (putter === buffers.EMPTY) {
        break;
      }
      put_handler = putter.handler;
      if (put_handler.is_active()) {
        callback = put_handler.commit();
        if (callback) {
          schedule(callback, true);
        }
        if (isReduced(this.xform["@@transducer/step"](this.buf, putter.value))) {
          this.close();
        }
      }
    }
    return new Box(value);
  }

  // Either the buffer is empty, in which case there won't be any
  // pending puts, or we don't have a buffer, in which case this loop
  // fulfills the first of them that is active (note that we don't
  // have to worry about transducers here since we require a buffer
  // for that).
  while (true) {
    putter = this.puts.pop();
    value = putter.value;
    if (putter === buffers.EMPTY) {
      break;
    }
    put_handler = putter.handler;
    if (put_handler.is_active()) {
      callback = put_handler.commit();
      if (callback) {
        schedule(callback, true);
      }
      return new Box(value);
    }
  }

  if (this.closed) {
    handler.commit();
    return new Box(CLOSED);
  }

  // No buffer, empty buffer, no pending puts. Queue this take now.
  if (this.dirty_takes > MAX_DIRTY) {
    this.takes.cleanup(function(handler) {
      return handler.is_active();
    });
    this.dirty_takes = 0;
  } else {
    this.dirty_takes ++;
  }
  if (this.takes.length >= MAX_QUEUE_SIZE) {
    throw new Error("No more than " + MAX_QUEUE_SIZE + " pending takes are allowed on a single channel.");
  }
  this.takes.unbounded_unshift(handler);
  return null;
};

Channel.prototype.close = function() {
  if (this.closed) {
    return;
  }
  this.closed = true;

  // TODO: Duplicate code. Make a "_flush" function or something
  if (this.buf) {
    this.buf.close();
    this.xform["@@transducer/result"](this.buf);
    while (true) {
      if (this.buf.count() === 0) {
        break;
      }
      taker = this.takes.pop();
      if (taker === buffers.EMPTY) {
        break;
      }
      if (taker.is_active()) {
        callback = taker.commit();
        var value = this.buf.remove();
        schedule(callback, value);
      }
    }
  }

  while (true) {
    var taker = this.takes.pop();
    if (taker === buffers.EMPTY) {
      break;
    }
    if (taker.is_active()) {
      var callback = taker.commit();
      schedule(callback, CLOSED);
    }
  }

  while (true) {
    var putter = this.puts.pop();
    if (putter === buffers.EMPTY) {
      break;
    }
    if (putter.handler.is_active()) {
      var put_callback = putter.handler.commit();
      if (put_callback) {
        schedule(put_callback, false);
      }
    }
  }
};


Channel.prototype.is_closed = function() {
  return this.closed;
};

function defaultHandler(e) {
  console.log('error in channel transformer', e.stack);
  return CLOSED;
}

function handleEx(buf, exHandler, e) {
  var def = (exHandler || defaultHandler)(e);
  if (def !== CLOSED) {
    buf.add(def);
  }
  return buf;
}

// The base transformer object to use with transducers
function AddTransformer() {
}

AddTransformer.prototype["@@transducer/init"] = function() {
  throw new Error('init not available');
};

AddTransformer.prototype["@@transducer/result"] = function(v) {
  return v;
};

AddTransformer.prototype["@@transducer/step"] = function(buffer, input) {
  buffer.add(input);
  return buffer;
};


function handleException(exHandler) {
  return function(xform) {
    return {
      "@@transducer/step": function(buffer, input) {
        try {
          return xform["@@transducer/step"](buffer, input);
        } catch (e) {
          return handleEx(buffer, exHandler, e);
        }
      },
      "@@transducer/result": function(buffer) {
        try {
          return xform["@@transducer/result"](buffer);
        } catch (e) {
          return handleEx(buffer, exHandler, e);
        }
      }
    };
  };
}

// XXX: This is inconsistent. We should either call the reducing
// function xform, or call the transducer xform, not both
exports.chan = function(buf, xform, exHandler) {
  if (xform) {
    if (!buf) {
      throw new Error("Only buffered channels can use transducers");
    }

    xform = xform(new AddTransformer());
  } else {
    xform = new AddTransformer();
  }
  xform = handleException(exHandler)(xform);

  return new Channel(buffers.ring(32), buffers.ring(32), buf, xform);
};

exports.Box = Box;
exports.Channel = Channel;
exports.CLOSED = CLOSED;

},{"./buffers":5,"./dispatch":7}],7:[function(require,module,exports){
"use strict";

// TODO: Use process.nextTick if it's available since it's more
// efficient
// http://howtonode.org/understanding-process-next-tick
// Maybe we don't even need to queue ourselves in that case?

// XXX: But http://blog.nodejs.org/2013/03/11/node-v0-10-0-stable/
// Looks like it will blow up the stack (or is that just about
// pre-empting IO (but that's already bad enough IMO)?)

// Looks like
// http://nodejs.org/api/process.html#process_process_nexttick_callback
// is the equivalent of our TASK_BATCH_SIZE

var buffers = require("./buffers");

var TASK_BATCH_SIZE = 1024;

var tasks = buffers.ring(32);
var running = false;
var queued = false;

var queue_dispatcher;

function process_messages() {
  running = true;
  queued = false;
  var count = 0;
  while (true) {
    var task = tasks.pop();
    if (task === buffers.EMPTY) {
      break;
    }
    // TODO: Don't we need a try/finally here?
    task();
    if (count >= TASK_BATCH_SIZE) {
      break;
    }
    count ++;
  }
  running = false;
  if (tasks.length > 0) {
    queue_dispatcher();
  }
}

if (typeof MessageChannel !== "undefined") {
  var message_channel = new MessageChannel();
  message_channel.port1.onmessage = function(_) {
    process_messages();
  };
  queue_dispatcher = function()  {
    if (!(queued && running)) {
      queued = true;
      message_channel.port2.postMessage(0);
    }
  };
} else if (typeof setImmediate !== "undefined") {
  queue_dispatcher = function() {
    if (!(queued && running)) {
      queued = true;
      setImmediate(process_messages);
    }
  };
} else {
  queue_dispatcher = function() {
    if (!(queued && running)) {
      queued = true;
      setTimeout(process_messages, 0);
    }
  };
}

exports.run = function (f) {
  tasks.unbounded_unshift(f);
  queue_dispatcher();
};

exports.queue_delay = function(f, delay) {
  setTimeout(f, delay);
};

},{"./buffers":5}],8:[function(require,module,exports){
"use strict";

var dispatch = require("./dispatch");
var select = require("./select");
var Channel = require("./channels").Channel;

var FnHandler = function(f) {
  this.f = f;
};

FnHandler.prototype.is_active = function() {
  return true;
};

FnHandler.prototype.commit = function() {
  return this.f;
};

function put_then_callback(channel, value, callback) {
  var result = channel._put(value, new FnHandler(callback));
  if (result && callback) {
    callback(result.value);
  }
}

function take_then_callback(channel, callback) {
  var result = channel._take(new FnHandler(callback));
  if (result) {
    callback(result.value);
  }
}

var Process = function(gen, onFinish, creator) {
  this.gen = gen;
  this.creatorFunc = creator;
  this.finished = false;
  this.onFinish = onFinish;
};

var Instruction = function(op, data) {
  this.op = op;
  this.data = data;
};

var TAKE = "take";
var PUT = "put";
var SLEEP = "sleep";
var ALTS = "alts";

// TODO FIX XXX: This is a (probably) temporary hack to avoid blowing
// up the stack, but it means double queueing when the value is not
// immediately available
Process.prototype._continue = function(response) {
  var self = this;
  dispatch.run(function() {
    self.run(response);
  });
};

Process.prototype._done = function(value) {
  if (!this.finished) {
    this.finished = true;
    var onFinish = this.onFinish;
    if (typeof onFinish === "function") {
      dispatch.run(function() {
        onFinish(value);
      });
    }
  }
};

Process.prototype.run = function(response) {
  if (this.finished) {
    return;
  }

  // TODO: Shouldn't we (optionally) stop error propagation here (and
  // signal the error through a channel or something)? Otherwise the
  // uncaught exception will crash some runtimes (e.g. Node)
  var iter = this.gen.next(response);
  if (iter.done) {
    this._done(iter.value);
    return;
  }

  var ins = iter.value;
  var self = this;

  if (ins instanceof Instruction) {
    switch (ins.op) {
    case PUT:
      var data = ins.data;
      put_then_callback(data.channel, data.value, function(ok) {
        self._continue(ok);
      });
      break;

    case TAKE:
      var channel = ins.data;
      take_then_callback(channel, function(value) {
        self._continue(value);
      });
      break;

    case SLEEP:
      var msecs = ins.data;
      dispatch.queue_delay(function() {
        self.run(null);
      }, msecs);
      break;

    case ALTS:
      select.do_alts(ins.data.operations, function(result) {
        self._continue(result);
      }, ins.data.options);
      break;
    }
  }
  else if(ins instanceof Channel) {
    var channel = ins;
    take_then_callback(channel, function(value) {
      self._continue(value);
    });
  }
  else {
    this._continue(ins);
  }
};

function take(channel) {
  return new Instruction(TAKE, channel);
}

function put(channel, value) {
  return new Instruction(PUT, {
    channel: channel,
    value: value
  });
}

function sleep(msecs) {
  return new Instruction(SLEEP, msecs);
}

function alts(operations, options) {
  return new Instruction(ALTS, {
    operations: operations,
    options: options
  });
}

exports.put_then_callback = put_then_callback;
exports.take_then_callback = take_then_callback;
exports.put = put;
exports.take = take;
exports.sleep = sleep;
exports.alts = alts;

exports.Process = Process;

},{"./channels":6,"./dispatch":7,"./select":9}],9:[function(require,module,exports){
"use strict";

var Box = require("./channels").Box;

var AltHandler = function(flag, f) {
  this.f = f;
  this.flag = flag;
};

AltHandler.prototype.is_active = function() {
  return this.flag.value;
};

AltHandler.prototype.commit = function() {
  this.flag.value = false;
  return this.f;
};

var AltResult = function(value, channel) {
  this.value = value;
  this.channel = channel;
};

function rand_int(n) {
  return Math.floor(Math.random() * (n + 1));
}

function random_array(n) {
  var a = new Array(n);
  var i;
  for (i = 0; i < n; i++) {
    a[i] = 0;
  }
  for (i = 1; i < n; i++) {
    var j = rand_int(i);
    a[i] = a[j];
    a[j] = i;
  }
  return a;
}

var hasOwnProperty = Object.prototype.hasOwnProperty;

var DEFAULT = {
  toString: function() {
    return "[object DEFAULT]";
  }
};

// TODO: Accept a priority function or something
exports.do_alts = function(operations, callback, options) {
  var length = operations.length;
  // XXX Hmm
  if (length === 0) {
    throw new Error("Empty alt list");
  }

  var priority = (options && options.priority) ? true : false;
  if (!priority) {
    var indexes = random_array(length);
  }

  var flag = new Box(true);

  for (var i = 0; i < length; i++) {
    var operation = operations[priority ? i : indexes[i]];
    var port, result;
    // XXX Hmm
    if (operation instanceof Array) {
      var value = operation[1];
      port = operation[0];
      // We wrap this in a function to capture the value of "port",
      // because js' closure captures vars by "references", not
      // values. "let port" would have worked, but I don't want to
      // raise the runtime requirement yet. TODO: So change this when
      // most runtimes are modern enough.
      result = port._put(value, (function(port) {
        return new AltHandler(flag, function(ok) {
          callback(new AltResult(ok, port));
        });
      })(port));
    } else {
      port = operation;
      result = port._take((function(port) {
        return new AltHandler(flag, function(value) {
          callback(new AltResult(value, port));
        });
      })(port));
    }
    // XXX Hmm
    if (result instanceof Box) {
      callback(new AltResult(result.value, port));
      break;
    }
  }

  if (!(result instanceof Box)
      && options
      && hasOwnProperty.call(options, "default")) {
    if (flag.value) {
      flag.value = false;
      callback(new AltResult(options["default"], DEFAULT));
    }
  }
};

exports.DEFAULT = DEFAULT;

},{"./channels":6}],10:[function(require,module,exports){
"use strict";

var dispatch = require("./dispatch");
var channels = require("./channels");

exports.timeout = function timeout_channel(msecs) {
  var chan = channels.chan();
  dispatch.queue_delay(function() {
    chan.close();
  }, msecs);
  return chan;
};

},{"./channels":6,"./dispatch":7}],11:[function(require,module,exports){
'use strict';

var _interopRequireWildcard = function (obj) { return obj && obj.__esModule ? obj : { 'default': obj }; };

var _csp = require('js-csp');

var _csp2 = _interopRequireWildcard(_csp);

window.csp = _csp2['default'];

},{"js-csp":2}]},{},[11])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvanMtY3NwL3NyYy9jc3AuY29yZS5qcyIsIm5vZGVfbW9kdWxlcy9qcy1jc3Avc3JjL2NzcC5qcyIsIm5vZGVfbW9kdWxlcy9qcy1jc3Avc3JjL2NzcC5vcGVyYXRpb25zLmpzIiwibm9kZV9tb2R1bGVzL2pzLWNzcC9zcmMvY3NwLnBpcGVsaW5lLmpzIiwibm9kZV9tb2R1bGVzL2pzLWNzcC9zcmMvaW1wbC9idWZmZXJzLmpzIiwibm9kZV9tb2R1bGVzL2pzLWNzcC9zcmMvaW1wbC9jaGFubmVscy5qcyIsIm5vZGVfbW9kdWxlcy9qcy1jc3Avc3JjL2ltcGwvZGlzcGF0Y2guanMiLCJub2RlX21vZHVsZXMvanMtY3NwL3NyYy9pbXBsL3Byb2Nlc3MuanMiLCJub2RlX21vZHVsZXMvanMtY3NwL3NyYy9pbXBsL3NlbGVjdC5qcyIsIm5vZGVfbW9kdWxlcy9qcy1jc3Avc3JjL2ltcGwvdGltZXJzLmpzIiwiL1VzZXJzL2cvY29kZS90ZXN0L21ha2VfY3NwL3NyYy9qcy9hcHAuanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3R4QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0dBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbE9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0VUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7OzttQkNaZ0IsUUFBUTs7OztBQUV4QixNQUFNLENBQUMsR0FBRyxtQkFBTSxDQUFDIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIlwidXNlIHN0cmljdFwiO1xuXG52YXIgYnVmZmVycyA9IHJlcXVpcmUoXCIuL2ltcGwvYnVmZmVyc1wiKTtcbnZhciBjaGFubmVscyA9IHJlcXVpcmUoXCIuL2ltcGwvY2hhbm5lbHNcIik7XG52YXIgc2VsZWN0ID0gcmVxdWlyZShcIi4vaW1wbC9zZWxlY3RcIik7XG52YXIgcHJvY2VzcyA9IHJlcXVpcmUoXCIuL2ltcGwvcHJvY2Vzc1wiKTtcbnZhciB0aW1lcnMgPSByZXF1aXJlKFwiLi9pbXBsL3RpbWVyc1wiKTtcblxuZnVuY3Rpb24gc3Bhd24oZ2VuLCBjcmVhdG9yKSB7XG4gIHZhciBjaCA9IGNoYW5uZWxzLmNoYW4oYnVmZmVycy5maXhlZCgxKSk7XG4gIChuZXcgcHJvY2Vzcy5Qcm9jZXNzKGdlbiwgZnVuY3Rpb24odmFsdWUpIHtcbiAgICBpZiAodmFsdWUgPT09IGNoYW5uZWxzLkNMT1NFRCkge1xuICAgICAgY2guY2xvc2UoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvY2Vzcy5wdXRfdGhlbl9jYWxsYmFjayhjaCwgdmFsdWUsIGZ1bmN0aW9uKG9rKSB7XG4gICAgICAgIGNoLmNsb3NlKCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH0sIGNyZWF0b3IpKS5ydW4oKTtcbiAgcmV0dXJuIGNoO1xufTtcblxuZnVuY3Rpb24gZ28oZiwgYXJncykge1xuICBhcmdzID0gYXJncyB8fCBbXTtcblxuICB2YXIgZ2VuID0gZi5hcHBseShudWxsLCBhcmdzKTtcbiAgcmV0dXJuIHNwYXduKGdlbiwgZik7XG59O1xuXG5mdW5jdGlvbiBjaGFuKGJ1ZmZlck9yTnVtYmVyLCB4Zm9ybSwgZXhIYW5kbGVyKSB7XG4gIHZhciBidWY7XG4gIGlmIChidWZmZXJPck51bWJlciA9PT0gMCkge1xuICAgIGJ1ZmZlck9yTnVtYmVyID0gbnVsbDtcbiAgfVxuICBpZiAodHlwZW9mIGJ1ZmZlck9yTnVtYmVyID09PSBcIm51bWJlclwiKSB7XG4gICAgYnVmID0gYnVmZmVycy5maXhlZChidWZmZXJPck51bWJlcik7XG4gIH0gZWxzZSB7XG4gICAgYnVmID0gYnVmZmVyT3JOdW1iZXI7XG4gIH1cbiAgcmV0dXJuIGNoYW5uZWxzLmNoYW4oYnVmLCB4Zm9ybSwgZXhIYW5kbGVyKTtcbn07XG5cbmZ1bmN0aW9uIHByb21pc2VDaGFuKHhmb3JtLCBleEhhbmRsZXIpe1xuICAgIHJldHVybiBjaGFuKGJ1ZmZlcnMucHJvbWlzZSgpLCB4Zm9ybSwgZXhIYW5kbGVyKTtcbn07XG5cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIGJ1ZmZlcnM6IHtcbiAgICBmaXhlZDogYnVmZmVycy5maXhlZCxcbiAgICBkcm9wcGluZzogYnVmZmVycy5kcm9wcGluZyxcbiAgICBzbGlkaW5nOiBidWZmZXJzLnNsaWRpbmcsXG4gICAgcHJvbWlzZTogYnVmZmVycy5wcm9taXNlXG4gIH0sXG5cbiAgc3Bhd246IHNwYXduLFxuICBnbzogZ28sXG4gIGNoYW46IGNoYW4sXG4gIHByb21pc2VDaGFuOiBwcm9taXNlQ2hhbixcbiAgREVGQVVMVDogc2VsZWN0LkRFRkFVTFQsXG4gIENMT1NFRDogY2hhbm5lbHMuQ0xPU0VELFxuXG4gIHB1dDogcHJvY2Vzcy5wdXQsXG4gIHRha2U6IHByb2Nlc3MudGFrZSxcbiAgc2xlZXA6IHByb2Nlc3Muc2xlZXAsXG4gIGFsdHM6IHByb2Nlc3MuYWx0cyxcbiAgcHV0QXN5bmM6IHByb2Nlc3MucHV0X3RoZW5fY2FsbGJhY2ssXG4gIHRha2VBc3luYzogcHJvY2Vzcy50YWtlX3RoZW5fY2FsbGJhY2ssXG5cbiAgdGltZW91dDogdGltZXJzLnRpbWVvdXRcbn07XG4iLCJcInVzZSBzdHJpY3RcIjtcblxudmFyIGNzcCA9IHJlcXVpcmUoXCIuL2NzcC5jb3JlXCIpO1xudmFyIG9wZXJhdGlvbnMgPSByZXF1aXJlKFwiLi9jc3Aub3BlcmF0aW9uc1wiKTtcbnZhciBwaXBlbGluZSA9IHJlcXVpcmUoJy4vY3NwLnBpcGVsaW5lJyk7XG5cbmNzcC5vcGVyYXRpb25zID0gb3BlcmF0aW9ucztcbmNzcC5vcGVyYXRpb25zLnBpcGVsaW5lID0gcGlwZWxpbmUucGlwZWxpbmU7XG5jc3Aub3BlcmF0aW9ucy5waXBlbGluZUFzeW5jID0gcGlwZWxpbmUucGlwZWxpbmVBc3luYztcblxubW9kdWxlLmV4cG9ydHMgPSBjc3A7XG4iLCJcInVzZSBzdHJpY3RcIjtcblxudmFyIEJveCA9IHJlcXVpcmUoXCIuL2ltcGwvY2hhbm5lbHNcIikuQm94O1xuXG52YXIgY3NwID0gcmVxdWlyZShcIi4vY3NwLmNvcmVcIiksXG4gICAgZ28gPSBjc3AuZ28sXG4gICAgdGFrZSA9IGNzcC50YWtlLFxuICAgIHB1dCA9IGNzcC5wdXQsXG4gICAgdGFrZUFzeW5jID0gY3NwLnRha2VBc3luYyxcbiAgICBwdXRBc3luYyA9IGNzcC5wdXRBc3luYyxcbiAgICBhbHRzID0gY3NwLmFsdHMsXG4gICAgY2hhbiA9IGNzcC5jaGFuLFxuICAgIENMT1NFRCA9IGNzcC5DTE9TRUQ7XG5cblxuZnVuY3Rpb24gbWFwRnJvbShmLCBjaCkge1xuICByZXR1cm4ge1xuICAgIGlzX2Nsb3NlZDogZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gY2guaXNfY2xvc2VkKCk7XG4gICAgfSxcbiAgICBjbG9zZTogZnVuY3Rpb24oKSB7XG4gICAgICBjaC5jbG9zZSgpO1xuICAgIH0sXG4gICAgX3B1dDogZnVuY3Rpb24odmFsdWUsIGhhbmRsZXIpIHtcbiAgICAgIHJldHVybiBjaC5fcHV0KHZhbHVlLCBoYW5kbGVyKTtcbiAgICB9LFxuICAgIF90YWtlOiBmdW5jdGlvbihoYW5kbGVyKSB7XG4gICAgICB2YXIgcmVzdWx0ID0gY2guX3Rha2Uoe1xuICAgICAgICBpc19hY3RpdmU6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHJldHVybiBoYW5kbGVyLmlzX2FjdGl2ZSgpO1xuICAgICAgICB9LFxuICAgICAgICBjb21taXQ6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgIHZhciB0YWtlX2NiID0gaGFuZGxlci5jb21taXQoKTtcbiAgICAgICAgICByZXR1cm4gZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgICAgIHJldHVybiB0YWtlX2NiKHZhbHVlID09PSBDTE9TRUQgPyBDTE9TRUQgOiBmKHZhbHVlKSk7XG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBpZiAocmVzdWx0KSB7XG4gICAgICAgIHZhciB2YWx1ZSA9IHJlc3VsdC52YWx1ZTtcbiAgICAgICAgcmV0dXJuIG5ldyBCb3godmFsdWUgPT09IENMT1NFRCA/IENMT1NFRCA6IGYodmFsdWUpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFwSW50byhmLCBjaCkge1xuICByZXR1cm4ge1xuICAgIGlzX2Nsb3NlZDogZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gY2guaXNfY2xvc2VkKCk7XG4gICAgfSxcbiAgICBjbG9zZTogZnVuY3Rpb24oKSB7XG4gICAgICBjaC5jbG9zZSgpO1xuICAgIH0sXG4gICAgX3B1dDogZnVuY3Rpb24odmFsdWUsIGhhbmRsZXIpIHtcbiAgICAgIHJldHVybiBjaC5fcHV0KGYodmFsdWUpLCBoYW5kbGVyKTtcbiAgICB9LFxuICAgIF90YWtlOiBmdW5jdGlvbihoYW5kbGVyKSB7XG4gICAgICByZXR1cm4gY2guX3Rha2UoaGFuZGxlcik7XG4gICAgfVxuICB9O1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJGcm9tKHAsIGNoLCBidWZmZXJPck4pIHtcbiAgdmFyIG91dCA9IGNoYW4oYnVmZmVyT3JOKTtcbiAgZ28oZnVuY3Rpb24qKCkge1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICB2YXIgdmFsdWUgPSB5aWVsZCB0YWtlKGNoKTtcbiAgICAgIGlmICh2YWx1ZSA9PT0gQ0xPU0VEKSB7XG4gICAgICAgIG91dC5jbG9zZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmIChwKHZhbHVlKSkge1xuICAgICAgICB5aWVsZCBwdXQob3V0LCB2YWx1ZSk7XG4gICAgICB9XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gZmlsdGVySW50byhwLCBjaCkge1xuICByZXR1cm4ge1xuICAgIGlzX2Nsb3NlZDogZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gY2guaXNfY2xvc2VkKCk7XG4gICAgfSxcbiAgICBjbG9zZTogZnVuY3Rpb24oKSB7XG4gICAgICBjaC5jbG9zZSgpO1xuICAgIH0sXG4gICAgX3B1dDogZnVuY3Rpb24odmFsdWUsIGhhbmRsZXIpIHtcbiAgICAgIGlmIChwKHZhbHVlKSkge1xuICAgICAgICByZXR1cm4gY2guX3B1dCh2YWx1ZSwgaGFuZGxlcik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gbmV3IEJveCghY2guaXNfY2xvc2VkKCkpO1xuICAgICAgfVxuICAgIH0sXG4gICAgX3Rha2U6IGZ1bmN0aW9uKGhhbmRsZXIpIHtcbiAgICAgIHJldHVybiBjaC5fdGFrZShoYW5kbGVyKTtcbiAgICB9XG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbW92ZUZyb20ocCwgY2gpIHtcbiAgcmV0dXJuIGZpbHRlckZyb20oZnVuY3Rpb24odmFsdWUpIHtcbiAgICByZXR1cm4gIXAodmFsdWUpO1xuICB9LCBjaCk7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZUludG8ocCwgY2gpIHtcbiAgcmV0dXJuIGZpbHRlckludG8oZnVuY3Rpb24odmFsdWUpIHtcbiAgICByZXR1cm4gIXAodmFsdWUpO1xuICB9LCBjaCk7XG59XG5cbmZ1bmN0aW9uKiBtYXBjYXQoZiwgc3JjLCBkc3QpIHtcbiAgd2hpbGUgKHRydWUpIHtcbiAgICB2YXIgdmFsdWUgPSB5aWVsZCB0YWtlKHNyYyk7XG4gICAgaWYgKHZhbHVlID09PSBDTE9TRUQpIHtcbiAgICAgIGRzdC5jbG9zZSgpO1xuICAgICAgYnJlYWs7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZhciBzZXEgPSBmKHZhbHVlKTtcbiAgICAgIHZhciBsZW5ndGggPSBzZXEubGVuZ3RoO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgICAgICB5aWVsZCBwdXQoZHN0LCBzZXFbaV0pO1xuICAgICAgfVxuICAgICAgaWYgKGRzdC5pc19jbG9zZWQoKSkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbWFwY2F0RnJvbShmLCBjaCwgYnVmZmVyT3JOKSB7XG4gIHZhciBvdXQgPSBjaGFuKGJ1ZmZlck9yTik7XG4gIGdvKG1hcGNhdCwgW2YsIGNoLCBvdXRdKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gbWFwY2F0SW50byhmLCBjaCwgYnVmZmVyT3JOKSB7XG4gIHZhciBzcmMgPSBjaGFuKGJ1ZmZlck9yTik7XG4gIGdvKG1hcGNhdCwgW2YsIHNyYywgY2hdKTtcbiAgcmV0dXJuIHNyYztcbn1cblxuZnVuY3Rpb24gcGlwZShzcmMsIGRzdCwga2VlcE9wZW4pIHtcbiAgZ28oZnVuY3Rpb24qKCkge1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICB2YXIgdmFsdWUgPSB5aWVsZCB0YWtlKHNyYyk7XG4gICAgICBpZiAodmFsdWUgPT09IENMT1NFRCkge1xuICAgICAgICBpZiAoIWtlZXBPcGVuKSB7XG4gICAgICAgICAgZHN0LmNsb3NlKCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBpZiAoISh5aWVsZCBwdXQoZHN0LCB2YWx1ZSkpKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiBkc3Q7XG59XG5cbmZ1bmN0aW9uIHNwbGl0KHAsIGNoLCB0cnVlQnVmZmVyT3JOLCBmYWxzZUJ1ZmZlck9yTikge1xuICB2YXIgdGNoID0gY2hhbih0cnVlQnVmZmVyT3JOKTtcbiAgdmFyIGZjaCA9IGNoYW4oZmFsc2VCdWZmZXJPck4pO1xuICBnbyhmdW5jdGlvbiooKSB7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHZhciB2YWx1ZSA9IHlpZWxkIHRha2UoY2gpO1xuICAgICAgaWYgKHZhbHVlID09PSBDTE9TRUQpIHtcbiAgICAgICAgdGNoLmNsb3NlKCk7XG4gICAgICAgIGZjaC5jbG9zZSgpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHlpZWxkIHB1dChwKHZhbHVlKSA/IHRjaCA6IGZjaCwgdmFsdWUpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBbdGNoLCBmY2hdO1xufVxuXG5mdW5jdGlvbiByZWR1Y2UoZiwgaW5pdCwgY2gpIHtcbiAgcmV0dXJuIGdvKGZ1bmN0aW9uKigpIHtcbiAgICB2YXIgcmVzdWx0ID0gaW5pdDtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgdmFyIHZhbHVlID0geWllbGQgdGFrZShjaCk7XG4gICAgICBpZiAodmFsdWUgPT09IENMT1NFRCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzdWx0ID0gZihyZXN1bHQsIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9XG4gIH0sIFtdLCB0cnVlKTtcbn1cblxuZnVuY3Rpb24gb250byhjaCwgY29sbCwga2VlcE9wZW4pIHtcbiAgcmV0dXJuIGdvKGZ1bmN0aW9uKigpIHtcbiAgICB2YXIgbGVuZ3RoID0gY29sbC5sZW5ndGg7XG4gICAgLy8gRklYOiBTaG91bGQgYmUgYSBnZW5lcmljIGxvb3BpbmcgaW50ZXJmYWNlIChmb3IuLi5pbj8pXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgICAgeWllbGQgcHV0KGNoLCBjb2xsW2ldKTtcbiAgICB9XG4gICAgaWYgKCFrZWVwT3Blbikge1xuICAgICAgY2guY2xvc2UoKTtcbiAgICB9XG4gIH0pO1xufVxuXG4vLyBUT0RPOiBCb3VuZGVkP1xuZnVuY3Rpb24gZnJvbUNvbGwoY29sbCkge1xuICB2YXIgY2ggPSBjaGFuKGNvbGwubGVuZ3RoKTtcbiAgb250byhjaCwgY29sbCk7XG4gIHJldHVybiBjaDtcbn1cblxuZnVuY3Rpb24gbWFwKGYsIGNocywgYnVmZmVyT3JOKSB7XG4gIHZhciBvdXQgPSBjaGFuKGJ1ZmZlck9yTik7XG4gIHZhciBsZW5ndGggPSBjaHMubGVuZ3RoO1xuICAvLyBBcnJheSBob2xkaW5nIDEgcm91bmQgb2YgdmFsdWVzXG4gIHZhciB2YWx1ZXMgPSBuZXcgQXJyYXkobGVuZ3RoKTtcbiAgLy8gVE9ETzogTm90IHN1cmUgd2h5IHdlIG5lZWQgYSBzaXplLTEgYnVmZmVyIGhlcmVcbiAgdmFyIGRjaGFuID0gY2hhbigxKTtcbiAgLy8gSG93IG1hbnkgbW9yZSBpdGVtcyB0aGlzIHJvdW5kXG4gIHZhciBkY291bnQ7XG4gIC8vIHB1dCBjYWxsYmFja3MgZm9yIGVhY2ggY2hhbm5lbFxuICB2YXIgZGNhbGxiYWNrcyA9IG5ldyBBcnJheShsZW5ndGgpO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSArKykge1xuICAgIGRjYWxsYmFja3NbaV0gPSAoZnVuY3Rpb24oaSkge1xuICAgICAgcmV0dXJuIGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIHZhbHVlc1tpXSA9IHZhbHVlO1xuICAgICAgICBkY291bnQgLS07XG4gICAgICAgIGlmIChkY291bnQgPT09IDApIHtcbiAgICAgICAgICBwdXRBc3luYyhkY2hhbiwgdmFsdWVzLnNsaWNlKDApKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICB9KGkpKTtcbiAgfVxuICBnbyhmdW5jdGlvbiooKSB7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGRjb3VudCA9IGxlbmd0aDtcbiAgICAgIC8vIFdlIGNvdWxkIGp1c3QgbGF1bmNoIG4gZ29yb3V0aW5lcyBoZXJlLCBidXQgZm9yIGVmZmNpZW5jeSB3ZVxuICAgICAgLy8gZG9uJ3RcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuZ3RoOyBpICsrKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgdGFrZUFzeW5jKGNoc1tpXSwgZGNhbGxiYWNrc1tpXSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBGSVg6IEhtbSB3aHkgY2F0Y2hpbmcgaGVyZT9cbiAgICAgICAgICBkY291bnQgLS07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHZhciB2YWx1ZXMgPSB5aWVsZCB0YWtlKGRjaGFuKTtcbiAgICAgIGZvciAoaSA9IDA7IGkgPCBsZW5ndGg7IGkgKyspIHtcbiAgICAgICAgaWYgKHZhbHVlc1tpXSA9PT0gQ0xPU0VEKSB7XG4gICAgICAgICAgb3V0LmNsb3NlKCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB5aWVsZCBwdXQob3V0LCBmLmFwcGx5KG51bGwsIHZhbHVlcykpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIG1lcmdlKGNocywgYnVmZmVyT3JOKSB7XG4gIHZhciBvdXQgPSBjaGFuKGJ1ZmZlck9yTik7XG4gIHZhciBhY3RpdmVzID0gY2hzLnNsaWNlKDApO1xuICBnbyhmdW5jdGlvbiooKSB7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGlmIChhY3RpdmVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHZhciByID0geWllbGQgYWx0cyhhY3RpdmVzKTtcbiAgICAgIHZhciB2YWx1ZSA9IHIudmFsdWU7XG4gICAgICBpZiAodmFsdWUgPT09IENMT1NFRCkge1xuICAgICAgICAvLyBSZW1vdmUgY2xvc2VkIGNoYW5uZWxcbiAgICAgICAgdmFyIGkgPSBhY3RpdmVzLmluZGV4T2Yoci5jaGFubmVsKTtcbiAgICAgICAgYWN0aXZlcy5zcGxpY2UoaSwgMSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgeWllbGQgcHV0KG91dCwgdmFsdWUpO1xuICAgIH1cbiAgICBvdXQuY2xvc2UoKTtcbiAgfSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIGludG8oY29sbCwgY2gpIHtcbiAgdmFyIHJlc3VsdCA9IGNvbGwuc2xpY2UoMCk7XG4gIHJldHVybiByZWR1Y2UoZnVuY3Rpb24ocmVzdWx0LCBpdGVtKSB7XG4gICAgcmVzdWx0LnB1c2goaXRlbSk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfSwgcmVzdWx0LCBjaCk7XG59XG5cbmZ1bmN0aW9uIHRha2VOKG4sIGNoLCBidWZmZXJPck4pIHtcbiAgdmFyIG91dCA9IGNoYW4oYnVmZmVyT3JOKTtcbiAgZ28oZnVuY3Rpb24qKCkge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbjsgaSArKykge1xuICAgICAgdmFyIHZhbHVlID0geWllbGQgdGFrZShjaCk7XG4gICAgICBpZiAodmFsdWUgPT09IENMT1NFRCkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHlpZWxkIHB1dChvdXQsIHZhbHVlKTtcbiAgICB9XG4gICAgb3V0LmNsb3NlKCk7XG4gIH0pO1xuICByZXR1cm4gb3V0O1xufVxuXG52YXIgTk9USElORyA9IHt9O1xuXG5mdW5jdGlvbiB1bmlxdWUoY2gsIGJ1ZmZlck9yTikge1xuICB2YXIgb3V0ID0gY2hhbihidWZmZXJPck4pO1xuICB2YXIgbGFzdCA9IE5PVEhJTkc7XG4gIGdvKGZ1bmN0aW9uKigpIHtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgdmFyIHZhbHVlID0geWllbGQgdGFrZShjaCk7XG4gICAgICBpZiAodmFsdWUgPT09IENMT1NFRCkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmICh2YWx1ZSA9PT0gbGFzdCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGxhc3QgPSB2YWx1ZTtcbiAgICAgIHlpZWxkIHB1dChvdXQsIHZhbHVlKTtcbiAgICB9XG4gICAgb3V0LmNsb3NlKCk7XG4gIH0pO1xuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiBwYXJ0aXRpb25CeShmLCBjaCwgYnVmZmVyT3JOKSB7XG4gIHZhciBvdXQgPSBjaGFuKGJ1ZmZlck9yTik7XG4gIHZhciBwYXJ0ID0gW107XG4gIHZhciBsYXN0ID0gTk9USElORztcbiAgZ28oZnVuY3Rpb24qKCkge1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICB2YXIgdmFsdWUgPSB5aWVsZCB0YWtlKGNoKTtcbiAgICAgIGlmICh2YWx1ZSA9PT0gQ0xPU0VEKSB7XG4gICAgICAgIGlmIChwYXJ0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICB5aWVsZCBwdXQob3V0LCBwYXJ0KTtcbiAgICAgICAgfVxuICAgICAgICBvdXQuY2xvc2UoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbmV3SXRlbSA9IGYodmFsdWUpO1xuICAgICAgICBpZiAobmV3SXRlbSA9PT0gbGFzdCB8fCBsYXN0ID09PSBOT1RISU5HKSB7XG4gICAgICAgICAgcGFydC5wdXNoKHZhbHVlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB5aWVsZCBwdXQob3V0LCBwYXJ0KTtcbiAgICAgICAgICBwYXJ0ID0gW3ZhbHVlXTtcbiAgICAgICAgfVxuICAgICAgICBsYXN0ID0gbmV3SXRlbTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiBwYXJ0aXRpb24obiwgY2gsIGJ1ZmZlck9yTikge1xuICB2YXIgb3V0ID0gY2hhbihidWZmZXJPck4pO1xuICBnbyhmdW5jdGlvbiooKSB7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHZhciBwYXJ0ID0gbmV3IEFycmF5KG4pO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICAgICAgdmFyIHZhbHVlID0geWllbGQgdGFrZShjaCk7XG4gICAgICAgIGlmICh2YWx1ZSA9PT0gQ0xPU0VEKSB7XG4gICAgICAgICAgaWYgKGkgPiAwKSB7XG4gICAgICAgICAgICB5aWVsZCBwdXQob3V0LCBwYXJ0LnNsaWNlKDAsIGkpKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb3V0LmNsb3NlKCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHBhcnRbaV0gPSB2YWx1ZTtcbiAgICAgIH1cbiAgICAgIHlpZWxkIHB1dChvdXQsIHBhcnQpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8vIEZvciBjaGFubmVsIGlkZW50aWZpY2F0aW9uXG52YXIgZ2VuSWQgPSAoZnVuY3Rpb24oKSB7XG4gIHZhciBpID0gMDtcbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIGkgKys7XG4gICAgcmV0dXJuIFwiXCIgKyBpO1xuICB9O1xufSkoKTtcblxudmFyIElEX0FUVFIgPSBcIl9fY3NwX2NoYW5uZWxfaWRcIjtcblxuLy8gVE9ETzogRG8gd2UgbmVlZCB0byBjaGVjayB3aXRoIGhhc093blByb3BlcnR5P1xuZnVuY3Rpb24gbGVuKG9iaikge1xuICB2YXIgY291bnQgPSAwO1xuICBmb3IgKHZhciBwIGluIG9iaikge1xuICAgIGNvdW50ICsrO1xuICB9XG4gIHJldHVybiBjb3VudDtcbn1cblxuZnVuY3Rpb24gY2hhbklkKGNoKSB7XG4gIHZhciBpZCA9IGNoW0lEX0FUVFJdO1xuICBpZiAoaWQgPT09IHVuZGVmaW5lZCkge1xuICAgIGlkID0gY2hbSURfQVRUUl0gPSBnZW5JZCgpO1xuICB9XG4gIHJldHVybiBpZDtcbn1cblxudmFyIE11bHQgPSBmdW5jdGlvbihjaCkge1xuICB0aGlzLnRhcHMgPSB7fTtcbiAgdGhpcy5jaCA9IGNoO1xufTtcblxudmFyIFRhcCA9IGZ1bmN0aW9uKGNoYW5uZWwsIGtlZXBPcGVuKSB7XG4gIHRoaXMuY2hhbm5lbCA9IGNoYW5uZWw7XG4gIHRoaXMua2VlcE9wZW4gPSBrZWVwT3Blbjtcbn07XG5cbk11bHQucHJvdG90eXBlLm11eGNoID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLmNoO1xufTtcblxuTXVsdC5wcm90b3R5cGUudGFwID0gZnVuY3Rpb24oY2gsIGtlZXBPcGVuKSB7XG4gIHZhciBpZCA9IGNoYW5JZChjaCk7XG4gIHRoaXMudGFwc1tpZF0gPSBuZXcgVGFwKGNoLCBrZWVwT3Blbik7XG59O1xuXG5NdWx0LnByb3RvdHlwZS51bnRhcCA9IGZ1bmN0aW9uKGNoKSB7XG4gIGRlbGV0ZSB0aGlzLnRhcHNbY2hhbklkKGNoKV07XG59O1xuXG5NdWx0LnByb3RvdHlwZS51bnRhcEFsbCA9IGZ1bmN0aW9uKCkge1xuICB0aGlzLnRhcHMgPSB7fTtcbn07XG5cbmZ1bmN0aW9uIG11bHQoY2gpIHtcbiAgdmFyIG0gPSBuZXcgTXVsdChjaCk7XG4gIHZhciBkY2hhbiA9IGNoYW4oMSk7XG4gIHZhciBkY291bnQ7XG4gIGZ1bmN0aW9uIG1ha2VEb25lQ2FsbGJhY2sodGFwKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKHN0aWxsT3Blbikge1xuICAgICAgZGNvdW50IC0tO1xuICAgICAgaWYgKGRjb3VudCA9PT0gMCkge1xuICAgICAgICBwdXRBc3luYyhkY2hhbiwgdHJ1ZSk7XG4gICAgICB9XG4gICAgICBpZiAoIXN0aWxsT3Blbikge1xuICAgICAgICBtLnVudGFwKHRhcC5jaGFubmVsKTtcbiAgICAgIH1cbiAgICB9O1xuICB9XG4gIGdvKGZ1bmN0aW9uKigpIHtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgdmFyIHZhbHVlID0geWllbGQgdGFrZShjaCk7XG4gICAgICB2YXIgaWQsIHQ7XG4gICAgICB2YXIgdGFwcyA9IG0udGFwcztcbiAgICAgIGlmICh2YWx1ZSA9PT0gQ0xPU0VEKSB7XG4gICAgICAgIGZvciAoaWQgaW4gdGFwcykge1xuICAgICAgICAgIHQgPSB0YXBzW2lkXTtcbiAgICAgICAgICBpZiAoIXQua2VlcE9wZW4pIHtcbiAgICAgICAgICAgIHQuY2hhbm5lbC5jbG9zZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyBUT0RPOiBJcyB0aGlzIG5lY2Vzc2FyeT9cbiAgICAgICAgbS51bnRhcEFsbCgpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGRjb3VudCA9IGxlbih0YXBzKTtcbiAgICAgIC8vIFhYWDogVGhpcyBpcyBiZWNhdXNlIHB1dEFzeW5jIGNhbiBhY3R1YWxseSBjYWxsIGJhY2tcbiAgICAgIC8vIGltbWVkaWF0ZWx5LiBGaXggdGhhdFxuICAgICAgdmFyIGluaXREY291bnQgPSBkY291bnQ7XG4gICAgICAvLyBQdXQgdmFsdWUgb24gdGFwcGluZyBjaGFubmVscy4uLlxuICAgICAgZm9yIChpZCBpbiB0YXBzKSB7XG4gICAgICAgIHQgPSB0YXBzW2lkXTtcbiAgICAgICAgcHV0QXN5bmModC5jaGFubmVsLCB2YWx1ZSwgbWFrZURvbmVDYWxsYmFjayh0KSk7XG4gICAgICB9XG4gICAgICAvLyAuLi4gd2FpdGluZyBmb3IgYWxsIHB1dHMgdG8gY29tcGxldGVcbiAgICAgIGlmIChpbml0RGNvdW50ID4gMCkge1xuICAgICAgICB5aWVsZCB0YWtlKGRjaGFuKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gbTtcbn1cblxubXVsdC50YXAgPSBmdW5jdGlvbiB0YXAobSwgY2gsIGtlZXBPcGVuKSB7XG4gIG0udGFwKGNoLCBrZWVwT3Blbik7XG4gIHJldHVybiBjaDtcbn07XG5cbm11bHQudW50YXAgPSBmdW5jdGlvbiB1bnRhcChtLCBjaCkge1xuICBtLnVudGFwKGNoKTtcbn07XG5cbm11bHQudW50YXBBbGwgPSBmdW5jdGlvbiB1bnRhcEFsbChtKSB7XG4gIG0udW50YXBBbGwoKTtcbn07XG5cbnZhciBNaXggPSBmdW5jdGlvbihjaCkge1xuICB0aGlzLmNoID0gY2g7XG4gIHRoaXMuc3RhdGVNYXAgPSB7fTtcbiAgdGhpcy5jaGFuZ2UgPSBjaGFuKCk7XG4gIHRoaXMuc29sb01vZGUgPSBtaXguTVVURTtcbn07XG5cbk1peC5wcm90b3R5cGUuX2NoYW5nZWQgPSBmdW5jdGlvbigpIHtcbiAgcHV0QXN5bmModGhpcy5jaGFuZ2UsIHRydWUpO1xufTtcblxuTWl4LnByb3RvdHlwZS5fZ2V0QWxsU3RhdGUgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGFsbFN0YXRlID0ge307XG4gIHZhciBzdGF0ZU1hcCA9IHRoaXMuc3RhdGVNYXA7XG4gIHZhciBzb2xvcyA9IFtdO1xuICB2YXIgbXV0ZXMgPSBbXTtcbiAgdmFyIHBhdXNlcyA9IFtdO1xuICB2YXIgcmVhZHM7XG4gIGZvciAodmFyIGlkIGluIHN0YXRlTWFwKSB7XG4gICAgdmFyIGNoYW5EYXRhID0gc3RhdGVNYXBbaWRdO1xuICAgIHZhciBzdGF0ZSA9IGNoYW5EYXRhLnN0YXRlO1xuICAgIHZhciBjaGFubmVsID0gY2hhbkRhdGEuY2hhbm5lbDtcbiAgICBpZiAoc3RhdGVbbWl4LlNPTE9dKSB7XG4gICAgICBzb2xvcy5wdXNoKGNoYW5uZWwpO1xuICAgIH1cbiAgICAvLyBUT0RPXG4gICAgaWYgKHN0YXRlW21peC5NVVRFXSkge1xuICAgICAgbXV0ZXMucHVzaChjaGFubmVsKTtcbiAgICB9XG4gICAgaWYgKHN0YXRlW21peC5QQVVTRV0pIHtcbiAgICAgIHBhdXNlcy5wdXNoKGNoYW5uZWwpO1xuICAgIH1cbiAgfVxuICB2YXIgaSwgbjtcbiAgaWYgKHRoaXMuc29sb01vZGUgPT09IG1peC5QQVVTRSAmJiBzb2xvcy5sZW5ndGggPiAwKSB7XG4gICAgbiA9IHNvbG9zLmxlbmd0aDtcbiAgICByZWFkcyA9IG5ldyBBcnJheShuICsgMSk7XG4gICAgZm9yIChpID0gMDsgaSA8IG47IGkrKykge1xuICAgICAgcmVhZHNbaV0gPSBzb2xvc1tpXTtcbiAgICB9XG4gICAgcmVhZHNbbl0gPSB0aGlzLmNoYW5nZTtcbiAgfSBlbHNlIHtcbiAgICByZWFkcyA9IFtdO1xuICAgIGZvciAoaWQgaW4gc3RhdGVNYXApIHtcbiAgICAgIGNoYW5EYXRhID0gc3RhdGVNYXBbaWRdO1xuICAgICAgY2hhbm5lbCA9IGNoYW5EYXRhLmNoYW5uZWw7XG4gICAgICBpZiAocGF1c2VzLmluZGV4T2YoY2hhbm5lbCkgPCAwKSB7XG4gICAgICAgIHJlYWRzLnB1c2goY2hhbm5lbCk7XG4gICAgICB9XG4gICAgfVxuICAgIHJlYWRzLnB1c2godGhpcy5jaGFuZ2UpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzb2xvczogc29sb3MsXG4gICAgbXV0ZXM6IG11dGVzLFxuICAgIHJlYWRzOiByZWFkc1xuICB9O1xufTtcblxuTWl4LnByb3RvdHlwZS5hZG1peCA9IGZ1bmN0aW9uKGNoKSB7XG4gIHRoaXMuc3RhdGVNYXBbY2hhbklkKGNoKV0gPSB7XG4gICAgY2hhbm5lbDogY2gsXG4gICAgc3RhdGU6IHt9XG4gIH07XG4gIHRoaXMuX2NoYW5nZWQoKTtcbn07XG5cbk1peC5wcm90b3R5cGUudW5taXggPSBmdW5jdGlvbihjaCkge1xuICBkZWxldGUgdGhpcy5zdGF0ZU1hcFtjaGFuSWQoY2gpXTtcbiAgdGhpcy5fY2hhbmdlZCgpO1xufTtcblxuTWl4LnByb3RvdHlwZS51bm1peEFsbCA9IGZ1bmN0aW9uKCkge1xuICB0aGlzLnN0YXRlTWFwID0ge307XG4gIHRoaXMuX2NoYW5nZWQoKTtcbn07XG5cbk1peC5wcm90b3R5cGUudG9nZ2xlID0gZnVuY3Rpb24odXBkYXRlU3RhdGVMaXN0KSB7XG4gIC8vIFtbY2gxLCB7fV0sIFtjaDIsIHtzb2xvOiB0cnVlfV1dO1xuICB2YXIgbGVuZ3RoID0gdXBkYXRlU3RhdGVMaXN0Lmxlbmd0aDtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW5ndGg7IGkrKykge1xuICAgIHZhciBjaCA9IHVwZGF0ZVN0YXRlTGlzdFtpXVswXTtcbiAgICB2YXIgaWQgPSBjaGFuSWQoY2gpO1xuICAgIHZhciB1cGRhdGVTdGF0ZSA9IHVwZGF0ZVN0YXRlTGlzdFtpXVsxXTtcbiAgICB2YXIgY2hhbkRhdGEgPSB0aGlzLnN0YXRlTWFwW2lkXTtcbiAgICBpZiAoIWNoYW5EYXRhKSB7XG4gICAgICBjaGFuRGF0YSA9IHRoaXMuc3RhdGVNYXBbaWRdID0ge1xuICAgICAgICBjaGFubmVsOiBjaCxcbiAgICAgICAgc3RhdGU6IHt9XG4gICAgICB9O1xuICAgIH1cbiAgICBmb3IgKHZhciBtb2RlIGluIHVwZGF0ZVN0YXRlKSB7XG4gICAgICBjaGFuRGF0YS5zdGF0ZVttb2RlXSA9IHVwZGF0ZVN0YXRlW21vZGVdO1xuICAgIH1cbiAgfVxuICB0aGlzLl9jaGFuZ2VkKCk7XG59O1xuXG5NaXgucHJvdG90eXBlLnNldFNvbG9Nb2RlID0gZnVuY3Rpb24obW9kZSkge1xuICBpZiAoVkFMSURfU09MT19NT0RFUy5pbmRleE9mKG1vZGUpIDwgMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk1vZGUgbXVzdCBiZSBvbmUgb2Y6IFwiLCBWQUxJRF9TT0xPX01PREVTLmpvaW4oXCIsIFwiKSk7XG4gIH1cbiAgdGhpcy5zb2xvTW9kZSA9IG1vZGU7XG4gIHRoaXMuX2NoYW5nZWQoKTtcbn07XG5cbmZ1bmN0aW9uIG1peChvdXQpIHtcbiAgdmFyIG0gPSBuZXcgTWl4KG91dCk7XG4gIGdvKGZ1bmN0aW9uKigpIHtcbiAgICB2YXIgc3RhdGUgPSBtLl9nZXRBbGxTdGF0ZSgpO1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICB2YXIgcmVzdWx0ID0geWllbGQgYWx0cyhzdGF0ZS5yZWFkcyk7XG4gICAgICB2YXIgdmFsdWUgPSByZXN1bHQudmFsdWU7XG4gICAgICB2YXIgY2hhbm5lbCA9IHJlc3VsdC5jaGFubmVsO1xuICAgICAgaWYgKHZhbHVlID09PSBDTE9TRUQpIHtcbiAgICAgICAgZGVsZXRlIG0uc3RhdGVNYXBbY2hhbklkKGNoYW5uZWwpXTtcbiAgICAgICAgc3RhdGUgPSBtLl9nZXRBbGxTdGF0ZSgpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChjaGFubmVsID09PSBtLmNoYW5nZSkge1xuICAgICAgICBzdGF0ZSA9IG0uX2dldEFsbFN0YXRlKCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgdmFyIHNvbG9zID0gc3RhdGUuc29sb3M7XG4gICAgICBpZiAoc29sb3MuaW5kZXhPZihjaGFubmVsKSA+IC0xIHx8XG4gICAgICAgICAgKHNvbG9zLmxlbmd0aCA9PT0gMCAmJiAhKHN0YXRlLm11dGVzLmluZGV4T2YoY2hhbm5lbCkgPiAtMSkpKSB7XG4gICAgICAgIHZhciBzdGlsbE9wZW4gPSB5aWVsZCBwdXQob3V0LCB2YWx1ZSk7XG4gICAgICAgIGlmICghc3RpbGxPcGVuKSB7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gbTtcbn1cblxubWl4Lk1VVEUgPSBcIm11dGVcIjtcbm1peC5QQVVTRSA9IFwicGF1c2VcIjtcbm1peC5TT0xPID0gXCJzb2xvXCI7XG52YXIgVkFMSURfU09MT19NT0RFUyA9IFttaXguTVVURSwgbWl4LlBBVVNFXTtcblxubWl4LmFkZCA9IGZ1bmN0aW9uIGFkbWl4KG0sIGNoKSB7XG4gIG0uYWRtaXgoY2gpO1xufTtcblxubWl4LnJlbW92ZSA9IGZ1bmN0aW9uIHVubWl4KG0sIGNoKSB7XG4gIG0udW5taXgoY2gpO1xufTtcblxubWl4LnJlbW92ZUFsbCA9IGZ1bmN0aW9uIHVubWl4QWxsKG0pIHtcbiAgbS51bm1peEFsbCgpO1xufTtcblxubWl4LnRvZ2dsZSA9IGZ1bmN0aW9uIHRvZ2dsZShtLCB1cGRhdGVTdGF0ZUxpc3QpIHtcbiAgbS50b2dnbGUodXBkYXRlU3RhdGVMaXN0KTtcbn07XG5cbm1peC5zZXRTb2xvTW9kZSA9IGZ1bmN0aW9uIHNldFNvbG9Nb2RlKG0sIG1vZGUpIHtcbiAgbS5zZXRTb2xvTW9kZShtb2RlKTtcbn07XG5cbmZ1bmN0aW9uIGNvbnN0YW50bHlOdWxsKCkge1xuICByZXR1cm4gbnVsbDtcbn1cblxudmFyIFB1YiA9IGZ1bmN0aW9uKGNoLCB0b3BpY0ZuLCBidWZmZXJGbikge1xuICB0aGlzLmNoID0gY2g7XG4gIHRoaXMudG9waWNGbiA9IHRvcGljRm47XG4gIHRoaXMuYnVmZmVyRm4gPSBidWZmZXJGbjtcbiAgdGhpcy5tdWx0cyA9IHt9O1xufTtcblxuUHViLnByb3RvdHlwZS5fZW5zdXJlTXVsdCA9IGZ1bmN0aW9uKHRvcGljKSB7XG4gIHZhciBtID0gdGhpcy5tdWx0c1t0b3BpY107XG4gIHZhciBidWZmZXJGbiA9IHRoaXMuYnVmZmVyRm47XG4gIGlmICghbSkge1xuICAgIG0gPSB0aGlzLm11bHRzW3RvcGljXSA9IG11bHQoY2hhbihidWZmZXJGbih0b3BpYykpKTtcbiAgfVxuICByZXR1cm4gbTtcbn07XG5cblB1Yi5wcm90b3R5cGUuc3ViID0gZnVuY3Rpb24odG9waWMsIGNoLCBrZWVwT3Blbikge1xuICB2YXIgbSA9IHRoaXMuX2Vuc3VyZU11bHQodG9waWMpO1xuICByZXR1cm4gbXVsdC50YXAobSwgY2gsIGtlZXBPcGVuKTtcbn07XG5cblB1Yi5wcm90b3R5cGUudW5zdWIgPSBmdW5jdGlvbih0b3BpYywgY2gpIHtcbiAgdmFyIG0gPSB0aGlzLm11bHRzW3RvcGljXTtcbiAgaWYgKG0pIHtcbiAgICBtdWx0LnVudGFwKG0sIGNoKTtcbiAgfVxufTtcblxuUHViLnByb3RvdHlwZS51bnN1YkFsbCA9IGZ1bmN0aW9uKHRvcGljKSB7XG4gIGlmICh0b3BpYyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhpcy5tdWx0cyA9IHt9O1xuICB9IGVsc2Uge1xuICAgIGRlbGV0ZSB0aGlzLm11bHRzW3RvcGljXTtcbiAgfVxufTtcblxuZnVuY3Rpb24gcHViKGNoLCB0b3BpY0ZuLCBidWZmZXJGbikge1xuICBidWZmZXJGbiA9IGJ1ZmZlckZuIHx8IGNvbnN0YW50bHlOdWxsO1xuICB2YXIgcCA9IG5ldyBQdWIoY2gsIHRvcGljRm4sIGJ1ZmZlckZuKTtcbiAgZ28oZnVuY3Rpb24qKCkge1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICB2YXIgdmFsdWUgPSB5aWVsZCB0YWtlKGNoKTtcbiAgICAgIHZhciBtdWx0cyA9IHAubXVsdHM7XG4gICAgICB2YXIgdG9waWM7XG4gICAgICBpZiAodmFsdWUgPT09IENMT1NFRCkge1xuICAgICAgICBmb3IgKHRvcGljIGluIG11bHRzKSB7XG4gICAgICAgICAgbXVsdHNbdG9waWNdLm11eGNoKCkuY2xvc2UoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIC8vIFRPRE86IFNvbWVob3cgZW5zdXJlL2RvY3VtZW50IHRoYXQgdGhpcyBtdXN0IHJldHVybiBhIHN0cmluZ1xuICAgICAgLy8gKG90aGVyd2lzZSB1c2UgcHJvcGVyIChoYXNoKW1hcHMpXG4gICAgICB0b3BpYyA9IHRvcGljRm4odmFsdWUpO1xuICAgICAgdmFyIG0gPSBtdWx0c1t0b3BpY107XG4gICAgICBpZiAobSkge1xuICAgICAgICB2YXIgc3RpbGxPcGVuID0geWllbGQgcHV0KG0ubXV4Y2goKSwgdmFsdWUpO1xuICAgICAgICBpZiAoIXN0aWxsT3Blbikge1xuICAgICAgICAgIGRlbGV0ZSBtdWx0c1t0b3BpY107XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gcDtcbn1cblxucHViLnN1YiA9IGZ1bmN0aW9uIHN1YihwLCB0b3BpYywgY2gsIGtlZXBPcGVuKSB7XG4gIHJldHVybiBwLnN1Yih0b3BpYywgY2gsIGtlZXBPcGVuKTtcbn07XG5cbnB1Yi51bnN1YiA9IGZ1bmN0aW9uIHVuc3ViKHAsIHRvcGljLCBjaCkge1xuICBwLnVuc3ViKHRvcGljLCBjaCk7XG59O1xuXG5wdWIudW5zdWJBbGwgPSBmdW5jdGlvbiB1bnN1YkFsbChwLCB0b3BpYykge1xuICBwLnVuc3ViQWxsKHRvcGljKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBtYXBGcm9tOiBtYXBGcm9tLFxuICBtYXBJbnRvOiBtYXBJbnRvLFxuICBmaWx0ZXJGcm9tOiBmaWx0ZXJGcm9tLFxuICBmaWx0ZXJJbnRvOiBmaWx0ZXJJbnRvLFxuICByZW1vdmVGcm9tOiByZW1vdmVGcm9tLFxuICByZW1vdmVJbnRvOiByZW1vdmVJbnRvLFxuICBtYXBjYXRGcm9tOiBtYXBjYXRGcm9tLFxuICBtYXBjYXRJbnRvOiBtYXBjYXRJbnRvLFxuXG4gIHBpcGU6IHBpcGUsXG4gIHNwbGl0OiBzcGxpdCxcbiAgcmVkdWNlOiByZWR1Y2UsXG4gIG9udG86IG9udG8sXG4gIGZyb21Db2xsOiBmcm9tQ29sbCxcblxuICBtYXA6IG1hcCxcbiAgbWVyZ2U6IG1lcmdlLFxuICBpbnRvOiBpbnRvLFxuICB0YWtlOiB0YWtlTixcbiAgdW5pcXVlOiB1bmlxdWUsXG4gIHBhcnRpdGlvbjogcGFydGl0aW9uLFxuICBwYXJ0aXRpb25CeTogcGFydGl0aW9uQnksXG5cbiAgbXVsdDogbXVsdCxcbiAgbWl4OiBtaXgsXG4gIHB1YjogcHViXG59O1xuXG5cbi8vIFBvc3NpYmxlIFwiZmx1aWRcIiBpbnRlcmZhY2VzOlxuXG4vLyB0aHJlYWQoXG4vLyAgIFtmcm9tQ29sbCwgWzEsIDIsIDMsIDRdXSxcbi8vICAgW21hcEZyb20sIGluY10sXG4vLyAgIFtpbnRvLCBbXV1cbi8vIClcblxuLy8gdGhyZWFkKFxuLy8gICBbZnJvbUNvbGwsIFsxLCAyLCAzLCA0XV0sXG4vLyAgIFttYXBGcm9tLCBpbmMsIF9dLFxuLy8gICBbaW50bywgW10sIF9dXG4vLyApXG5cbi8vIHdyYXAoKVxuLy8gICAuZnJvbUNvbGwoWzEsIDIsIDMsIDRdKVxuLy8gICAubWFwRnJvbShpbmMpXG4vLyAgIC5pbnRvKFtdKVxuLy8gICAudW53cmFwKCk7XG4iLCJcInVzZSBzdHJpY3RcIjtcblxudmFyIGNzcCA9IHJlcXVpcmUoJy4vY3NwLmNvcmUnKTtcblxuZnVuY3Rpb24gcGlwZWxpbmVJbnRlcm5hbChuLCB0bywgZnJvbSwgY2xvc2UsIHRhc2tGbikge1xuICBpZiAobiA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCduIG11c3QgYmUgcG9zaXRpdmUnKTtcbiAgfVxuXG4gIHZhciBqb2JzID0gY3NwLmNoYW4obik7XG4gIHZhciByZXN1bHRzID0gY3NwLmNoYW4obik7XG5cbiAgZm9yKHZhciBfID0gMDsgXyA8IG47IF8rKykge1xuICAgIGNzcC5nbyhmdW5jdGlvbiogKHRhc2tGbiwgam9icywgcmVzdWx0cykge1xuICAgICAgd2hpbGUgKHRydWUpIHtcbiAgICAgICAgdmFyIGpvYiA9IHlpZWxkIGNzcC50YWtlKGpvYnMpO1xuXG4gICAgICAgIGlmICghdGFza0ZuKGpvYikpIHtcbiAgICAgICAgICByZXN1bHRzLmNsb3NlKCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LCBbdGFza0ZuLCBqb2JzLCByZXN1bHRzXSk7XG4gIH1cblxuICBjc3AuZ28oZnVuY3Rpb24qIChqb2JzLCBmcm9tLCByZXN1bHRzKSB7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHZhciB2ID0geWllbGQgY3NwLnRha2UoZnJvbSk7XG4gICAgICBpZiAodiA9PT0gY3NwLkNMT1NFRCkge1xuICAgICAgICBqb2JzLmNsb3NlKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIHAgPSBjc3AuY2hhbigxKTtcblxuICAgICAgICB5aWVsZCBjc3AucHV0KGpvYnMsIFt2LCBwXSk7XG4gICAgICAgIHlpZWxkIGNzcC5wdXQocmVzdWx0cywgcCk7XG4gICAgICB9XG4gICAgfVxuICB9LCBbam9icywgZnJvbSwgcmVzdWx0c10pO1xuXG4gIGNzcC5nbyhmdW5jdGlvbiogKHJlc3VsdHMsIGNsb3NlLCB0bykge1xuICAgIHdoaWxlKHRydWUpIHtcbiAgICAgIHZhciBwID0geWllbGQgY3NwLnRha2UocmVzdWx0cyk7XG4gICAgICBpZiAocCA9PT0gY3NwLkNMT1NFRCkge1xuICAgICAgICBpZiAoY2xvc2UpIHtcbiAgICAgICAgICB0by5jbG9zZSgpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIHJlcyA9IHlpZWxkIGNzcC50YWtlKHApO1xuICAgICAgICB3aGlsZSh0cnVlKSB7XG4gICAgICAgICAgdmFyIHYgPSB5aWVsZCBjc3AudGFrZShyZXMpO1xuICAgICAgICAgIGlmICh2ICE9PSBjc3AuQ0xPU0VEKSB7XG4gICAgICAgICAgICB5aWVsZCBjc3AucHV0KHRvLCB2KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9LCBbcmVzdWx0cywgY2xvc2UsIHRvXSk7XG5cbiAgcmV0dXJuIHRvO1xufVxuXG5mdW5jdGlvbiBwaXBlbGluZSh0bywgeGYsIGZyb20sIGtlZXBPcGVuLCBleEhhbmRsZXIpIHtcblxuICBmdW5jdGlvbiB0YXNrRm4oam9iKSB7XG4gICAgaWYgKGpvYiA9PT0gY3NwLkNMT1NFRCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZhciB2ID0gam9iWzBdO1xuICAgICAgdmFyIHAgPSBqb2JbMV07XG4gICAgICB2YXIgcmVzID0gY3NwLmNoYW4oMSwgeGYsIGV4SGFuZGxlcik7XG5cbiAgICAgIGNzcC5nbyhmdW5jdGlvbiogKHJlcywgdikge1xuICAgICAgICB5aWVsZCBjc3AucHV0KHJlcywgdik7XG4gICAgICAgIHJlcy5jbG9zZSgpO1xuICAgICAgfSwgW3Jlcywgdl0pO1xuXG4gICAgICBjc3AucHV0QXN5bmMocCwgcmVzKTtcblxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHBpcGVsaW5lSW50ZXJuYWwoMSwgdG8sIGZyb20sICFrZWVwT3BlbiwgdGFza0ZuKTtcbn1cblxuZnVuY3Rpb24gcGlwZWxpbmVBc3luYyhuLCB0bywgYWYsIGZyb20sIGtlZXBPcGVuKSB7XG5cbiAgZnVuY3Rpb24gdGFza0ZuKGpvYikge1xuICAgIGlmIChqb2IgPT09IGNzcC5DTE9TRUQpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0gZWxzZSB7XG4gICAgICB2YXIgdiA9IGpvYlswXTtcbiAgICAgIHZhciBwID0gam9iWzFdO1xuICAgICAgdmFyIHJlcyA9IGNzcC5jaGFuKDEpO1xuICAgICAgYWYodiwgcmVzKTtcbiAgICAgIGNzcC5wdXRBc3luYyhwLCByZXMpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHBpcGVsaW5lSW50ZXJuYWwobiwgdG8sIGZyb20sICFrZWVwT3BlbiwgdGFza0ZuKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIHBpcGVsaW5lOiBwaXBlbGluZSxcbiAgcGlwZWxpbmVBc3luYzogcGlwZWxpbmVBc3luY1xufTtcbiIsIlwidXNlIHN0cmljdFwiO1xuXG4vLyBUT0RPOiBDb25zaWRlciBFbXB0eUVycm9yICYgRnVsbEVycm9yIHRvIGF2b2lkIHJlZHVuZGFudCBib3VuZFxuLy8gY2hlY2tzLCB0byBpbXByb3ZlIHBlcmZvcm1hbmNlIChtYXkgbmVlZCBiZW5jaG1hcmtzKVxuXG5mdW5jdGlvbiBhY29weShzcmMsIHNyY19zdGFydCwgZHN0LCBkc3Rfc3RhcnQsIGxlbmd0aCkge1xuICB2YXIgY291bnQgPSAwO1xuICB3aGlsZSAodHJ1ZSkge1xuICAgIGlmIChjb3VudCA+PSBsZW5ndGgpIHtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBkc3RbZHN0X3N0YXJ0ICsgY291bnRdID0gc3JjW3NyY19zdGFydCArIGNvdW50XTtcbiAgICBjb3VudCArKztcbiAgfVxufVxuXG5mdW5jdGlvbiBub29wKCkge307XG5cbnZhciBFTVBUWSA9IHtcbiAgdG9TdHJpbmc6IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBcIltvYmplY3QgRU1QVFldXCI7XG4gIH1cbn07XG5cbnZhciBSaW5nQnVmZmVyID0gZnVuY3Rpb24oaGVhZCwgdGFpbCwgbGVuZ3RoLCBhcnJheSkge1xuICB0aGlzLmxlbmd0aCA9IGxlbmd0aDtcbiAgdGhpcy5hcnJheSA9IGFycmF5O1xuICB0aGlzLmhlYWQgPSBoZWFkO1xuICB0aGlzLnRhaWwgPSB0YWlsO1xufTtcblxuLy8gSW50ZXJuYWwgbWV0aG9kLCBjYWxsZXJzIG11c3QgZG8gYm91bmQgY2hlY2tcblJpbmdCdWZmZXIucHJvdG90eXBlLl91bnNoaWZ0ID0gZnVuY3Rpb24oaXRlbSkge1xuICB2YXIgYXJyYXkgPSB0aGlzLmFycmF5O1xuICB2YXIgaGVhZCA9IHRoaXMuaGVhZDtcbiAgYXJyYXlbaGVhZF0gPSBpdGVtO1xuICB0aGlzLmhlYWQgPSAoaGVhZCArIDEpICUgYXJyYXkubGVuZ3RoO1xuICB0aGlzLmxlbmd0aCArKztcbn07XG5cblJpbmdCdWZmZXIucHJvdG90eXBlLl9yZXNpemUgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGFycmF5ID0gdGhpcy5hcnJheTtcbiAgdmFyIG5ld19sZW5ndGggPSAyICogYXJyYXkubGVuZ3RoO1xuICB2YXIgbmV3X2FycmF5ID0gbmV3IEFycmF5KG5ld19sZW5ndGgpO1xuICB2YXIgaGVhZCA9IHRoaXMuaGVhZDtcbiAgdmFyIHRhaWwgPSB0aGlzLnRhaWw7XG4gIHZhciBsZW5ndGggPSB0aGlzLmxlbmd0aDtcbiAgaWYgKHRhaWwgPCBoZWFkKSB7XG4gICAgYWNvcHkoYXJyYXksIHRhaWwsIG5ld19hcnJheSwgMCwgbGVuZ3RoKTtcbiAgICB0aGlzLnRhaWwgPSAwO1xuICAgIHRoaXMuaGVhZCA9IGxlbmd0aDtcbiAgICB0aGlzLmFycmF5ID0gbmV3X2FycmF5O1xuICB9IGVsc2UgaWYgKHRhaWwgPiBoZWFkKSB7XG4gICAgYWNvcHkoYXJyYXksIHRhaWwsIG5ld19hcnJheSwgMCwgYXJyYXkubGVuZ3RoIC0gdGFpbCk7XG4gICAgYWNvcHkoYXJyYXksIDAsIG5ld19hcnJheSwgYXJyYXkubGVuZ3RoIC0gdGFpbCwgaGVhZCk7XG4gICAgdGhpcy50YWlsID0gMDtcbiAgICB0aGlzLmhlYWQgPSBsZW5ndGg7XG4gICAgdGhpcy5hcnJheSA9IG5ld19hcnJheTtcbiAgfSBlbHNlIGlmICh0YWlsID09PSBoZWFkKSB7XG4gICAgdGhpcy50YWlsID0gMDtcbiAgICB0aGlzLmhlYWQgPSAwO1xuICAgIHRoaXMuYXJyYXkgPSBuZXdfYXJyYXk7XG4gIH1cbn07XG5cblJpbmdCdWZmZXIucHJvdG90eXBlLnVuYm91bmRlZF91bnNoaWZ0ID0gZnVuY3Rpb24oaXRlbSkge1xuICBpZiAodGhpcy5sZW5ndGggKyAxID09PSB0aGlzLmFycmF5Lmxlbmd0aCkge1xuICAgIHRoaXMuX3Jlc2l6ZSgpO1xuICB9XG4gIHRoaXMuX3Vuc2hpZnQoaXRlbSk7XG59O1xuXG5SaW5nQnVmZmVyLnByb3RvdHlwZS5wb3AgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIEVNUFRZO1xuICB9XG4gIHZhciBhcnJheSA9IHRoaXMuYXJyYXk7XG4gIHZhciB0YWlsID0gdGhpcy50YWlsO1xuICB2YXIgaXRlbSA9IGFycmF5W3RhaWxdO1xuICBhcnJheVt0YWlsXSA9IG51bGw7XG4gIHRoaXMudGFpbCA9ICh0YWlsICsgMSkgJSBhcnJheS5sZW5ndGg7XG4gIHRoaXMubGVuZ3RoIC0tO1xuICByZXR1cm4gaXRlbTtcbn07XG5cblJpbmdCdWZmZXIucHJvdG90eXBlLmNsZWFudXAgPSBmdW5jdGlvbihwcmVkaWNhdGUpIHtcbiAgdmFyIGxlbmd0aCA9IHRoaXMubGVuZ3RoO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIGl0ZW0gPSB0aGlzLnBvcCgpO1xuICAgIGlmIChwcmVkaWNhdGUoaXRlbSkpIHtcbiAgICAgIHRoaXMuX3Vuc2hpZnQoaXRlbSk7XG4gICAgfVxuICB9XG59O1xuXG52YXIgRml4ZWRCdWZmZXIgPSBmdW5jdGlvbihidWYsICBuKSB7XG4gIHRoaXMuYnVmID0gYnVmO1xuICB0aGlzLm4gPSBuO1xufTtcblxuRml4ZWRCdWZmZXIucHJvdG90eXBlLmlzX2Z1bGwgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuYnVmLmxlbmd0aCA+PSB0aGlzLm47XG59O1xuXG5GaXhlZEJ1ZmZlci5wcm90b3R5cGUucmVtb3ZlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLmJ1Zi5wb3AoKTtcbn07XG5cbkZpeGVkQnVmZmVyLnByb3RvdHlwZS5hZGQgPSBmdW5jdGlvbihpdGVtKSB7XG4gIC8vIE5vdGUgdGhhdCBldmVuIHRob3VnaCB0aGUgdW5kZXJseWluZyBidWZmZXIgbWF5IGdyb3csIFwiblwiIGlzXG4gIC8vIGZpeGVkIHNvIGFmdGVyIG92ZXJmbG93aW5nIHRoZSBidWZmZXIgaXMgc3RpbGwgY29uc2lkZXJlZCBmdWxsLlxuICB0aGlzLmJ1Zi51bmJvdW5kZWRfdW5zaGlmdChpdGVtKTtcbn07XG5cbkZpeGVkQnVmZmVyLnByb3RvdHlwZS5jb3VudCA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5idWYubGVuZ3RoO1xufTtcblxuRml4ZWRCdWZmZXIucHJvdG90eXBlLmNsb3NlID0gbm9vcDtcblxudmFyIERyb3BwaW5nQnVmZmVyID0gZnVuY3Rpb24oYnVmLCBuKSB7XG4gIHRoaXMuYnVmID0gYnVmO1xuICB0aGlzLm4gPSBuO1xufTtcblxuRHJvcHBpbmdCdWZmZXIucHJvdG90eXBlLmlzX2Z1bGwgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIGZhbHNlO1xufTtcblxuRHJvcHBpbmdCdWZmZXIucHJvdG90eXBlLnJlbW92ZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5idWYucG9wKCk7XG59O1xuXG5Ecm9wcGluZ0J1ZmZlci5wcm90b3R5cGUuYWRkID0gZnVuY3Rpb24oaXRlbSkge1xuICBpZiAodGhpcy5idWYubGVuZ3RoIDwgdGhpcy5uKSB7XG4gICAgdGhpcy5idWYuX3Vuc2hpZnQoaXRlbSk7XG4gIH1cbn07XG5cbkRyb3BwaW5nQnVmZmVyLnByb3RvdHlwZS5jb3VudCA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5idWYubGVuZ3RoO1xufTtcblxuRHJvcHBpbmdCdWZmZXIucHJvdG90eXBlLmNsb3NlID0gbm9vcDtcblxudmFyIFNsaWRpbmdCdWZmZXIgPSBmdW5jdGlvbihidWYsIG4pIHtcbiAgdGhpcy5idWYgPSBidWY7XG4gIHRoaXMubiA9IG47XG59O1xuXG5TbGlkaW5nQnVmZmVyLnByb3RvdHlwZS5pc19mdWxsID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiBmYWxzZTtcbn07XG5cblNsaWRpbmdCdWZmZXIucHJvdG90eXBlLnJlbW92ZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5idWYucG9wKCk7XG59O1xuXG5TbGlkaW5nQnVmZmVyLnByb3RvdHlwZS5hZGQgPSBmdW5jdGlvbihpdGVtKSB7XG4gIGlmICh0aGlzLmJ1Zi5sZW5ndGggPT09IHRoaXMubikge1xuICAgIHRoaXMuYnVmLnBvcCgpO1xuICB9XG4gIHRoaXMuYnVmLl91bnNoaWZ0KGl0ZW0pO1xufTtcblxuU2xpZGluZ0J1ZmZlci5wcm90b3R5cGUuY291bnQgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuYnVmLmxlbmd0aDtcbn07XG5cblNsaWRpbmdCdWZmZXIucHJvdG90eXBlLmNsb3NlID0gbm9vcDtcblxudmFyIFByb21pc2VCdWZmZXIgPSBmdW5jdGlvbiBQcm9taXNlQnVmZmVyKCkge1xuICB0aGlzLnZhbCA9IEVNUFRZO1xufTtcblxuUHJvbWlzZUJ1ZmZlci5wcm90b3R5cGUuY291bnQgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuICh0aGlzLnZhbCA9PT0gRU1QVFkpID8gMCA6IDE7XG59O1xuXG5Qcm9taXNlQnVmZmVyLnByb3RvdHlwZS5hZGQgPSBmdW5jdGlvbihpdGVtKSB7XG4gIGlmICh0aGlzLnZhbCA9PT0gRU1QVFkpIHtcbiAgICB0aGlzLnZhbCA9IGl0ZW07XG4gIH1cbn07XG5cblByb21pc2VCdWZmZXIucHJvdG90eXBlLmlzX2Z1bGwgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIGZhbHNlO1xufTtcblxuUHJvbWlzZUJ1ZmZlci5wcm90b3R5cGUucmVtb3ZlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLnZhbDtcbn07XG5cblByb21pc2VCdWZmZXIucHJvdG90eXBlLmNsb3NlID0gZnVuY3Rpb24oKSB7XG4gIHRoaXMudmFsID0gRU1QVFk7XG59O1xuXG52YXIgcmluZyA9IGV4cG9ydHMucmluZyA9IGZ1bmN0aW9uIHJpbmdfYnVmZmVyKG4pIHtcbiAgcmV0dXJuIG5ldyBSaW5nQnVmZmVyKDAsIDAsIDAsIG5ldyBBcnJheShuKSk7XG59O1xuXG4vKipcbiAqIFJldHVybnMgYSBidWZmZXIgdGhhdCBpcyBjb25zaWRlcmVkIFwiZnVsbFwiIHdoZW4gaXQgcmVhY2hlcyBzaXplIG4sXG4gKiBidXQgc3RpbGwgYWNjZXB0cyBhZGRpdGlvbmFsIGl0ZW1zLCBlZmZlY3RpdmVseSBhbGxvdyBvdmVyZmxvd2luZy5cbiAqIFRoZSBvdmVyZmxvd2luZyBiZWhhdmlvciBpcyB1c2VmdWwgZm9yIHN1cHBvcnRpbmcgXCJleHBhbmRpbmdcIlxuICogdHJhbnNkdWNlcnMsIHdoZXJlIHdlIHdhbnQgdG8gY2hlY2sgaWYgYSBidWZmZXIgaXMgZnVsbCBiZWZvcmVcbiAqIHJ1bm5pbmcgdGhlIHRyYW5zZHVjZWQgc3RlcCBmdW5jdGlvbiwgd2hpbGUgc3RpbGwgYWxsb3dpbmcgYVxuICogdHJhbnNkdWNlZCBzdGVwIHRvIGV4cGFuZCBpbnRvIG11bHRpcGxlIFwiZXNzZW5jZVwiIHN0ZXBzLlxuICovXG5leHBvcnRzLmZpeGVkID0gZnVuY3Rpb24gZml4ZWRfYnVmZmVyKG4pIHtcbiAgcmV0dXJuIG5ldyBGaXhlZEJ1ZmZlcihyaW5nKG4pLCBuKTtcbn07XG5cbmV4cG9ydHMuZHJvcHBpbmcgPSBmdW5jdGlvbiBkcm9wcGluZ19idWZmZXIobikge1xuICByZXR1cm4gbmV3IERyb3BwaW5nQnVmZmVyKHJpbmcobiksIG4pO1xufTtcblxuZXhwb3J0cy5zbGlkaW5nID0gZnVuY3Rpb24gc2xpZGluZ19idWZmZXIobikge1xuICByZXR1cm4gbmV3IFNsaWRpbmdCdWZmZXIocmluZyhuKSwgbik7XG59O1xuXG5leHBvcnRzLnByb21pc2UgPSBmdW5jdGlvbiBwcm9taXNlX2J1ZmZlcigpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlQnVmZmVyKCk7XG59O1xuXG5leHBvcnRzLkVNUFRZID0gRU1QVFk7XG4iLCJcInVzZSBzdHJpY3RcIjtcblxudmFyIGJ1ZmZlcnMgPSByZXF1aXJlKFwiLi9idWZmZXJzXCIpO1xudmFyIGRpc3BhdGNoID0gcmVxdWlyZShcIi4vZGlzcGF0Y2hcIik7XG5cbnZhciBNQVhfRElSVFkgPSA2NDtcbnZhciBNQVhfUVVFVUVfU0laRSA9IDEwMjQ7XG5cbnZhciBDTE9TRUQgPSBudWxsO1xuXG52YXIgQm94ID0gZnVuY3Rpb24odmFsdWUpIHtcbiAgdGhpcy52YWx1ZSA9IHZhbHVlO1xufTtcblxudmFyIFB1dEJveCA9IGZ1bmN0aW9uKGhhbmRsZXIsIHZhbHVlKSB7XG4gIHRoaXMuaGFuZGxlciA9IGhhbmRsZXI7XG4gIHRoaXMudmFsdWUgPSB2YWx1ZTtcbn07XG5cbnZhciBDaGFubmVsID0gZnVuY3Rpb24odGFrZXMsIHB1dHMsIGJ1ZiwgeGZvcm0pIHtcbiAgdGhpcy5idWYgPSBidWY7XG4gIHRoaXMueGZvcm0gPSB4Zm9ybTtcbiAgdGhpcy50YWtlcyA9IHRha2VzO1xuICB0aGlzLnB1dHMgPSBwdXRzO1xuXG4gIHRoaXMuZGlydHlfdGFrZXMgPSAwO1xuICB0aGlzLmRpcnR5X3B1dHMgPSAwO1xuICB0aGlzLmNsb3NlZCA9IGZhbHNlO1xufTtcblxuZnVuY3Rpb24gaXNSZWR1Y2VkKHYpIHtcbiAgcmV0dXJuIHYgJiYgdltcIkBAdHJhbnNkdWNlci9yZWR1Y2VkXCJdO1xufVxuXG5mdW5jdGlvbiBzY2hlZHVsZShmLCB2KSB7XG4gIGRpc3BhdGNoLnJ1bihmdW5jdGlvbigpIHtcbiAgICBmKHYpO1xuICB9KTtcbn1cblxuQ2hhbm5lbC5wcm90b3R5cGUuX3B1dCA9IGZ1bmN0aW9uKHZhbHVlLCBoYW5kbGVyKSB7XG4gIGlmICh2YWx1ZSA9PT0gQ0xPU0VEKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IHB1dCBDTE9TRUQgb24gYSBjaGFubmVsLlwiKTtcbiAgfVxuXG4gIC8vIFRPRE86IEknbSBub3Qgc3VyZSBob3cgdGhpcyBjYW4gaGFwcGVuLCBiZWNhdXNlIHRoZSBvcGVyYXRpb25zXG4gIC8vIGFyZSByZWdpc3RlcmVkIGluIDEgdGljaywgYW5kIHRoZSBvbmx5IHdheSBmb3IgdGhpcyB0byBiZSBpbmFjdGl2ZVxuICAvLyBpcyBmb3IgYSBwcmV2aW91cyBvcGVyYXRpb24gaW4gdGhlIHNhbWUgYWx0IHRvIGhhdmUgcmV0dXJuZWRcbiAgLy8gaW1tZWRpYXRlbHksIHdoaWNoIHdvdWxkIGhhdmUgc2hvcnQtY2lyY3VpdGVkIHRvIHByZXZlbnQgdGhpcyB0b1xuICAvLyBiZSBldmVyIHJlZ2lzdGVyIGFueXdheS4gVGhlIHNhbWUgdGhpbmcgZ29lcyBmb3IgdGhlIGFjdGl2ZSBjaGVja1xuICAvLyBpbiBcIl90YWtlXCIuXG4gIGlmICghaGFuZGxlci5pc19hY3RpdmUoKSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgaWYgKHRoaXMuY2xvc2VkKSB7XG4gICAgaGFuZGxlci5jb21taXQoKTtcbiAgICByZXR1cm4gbmV3IEJveChmYWxzZSk7XG4gIH1cblxuICB2YXIgdGFrZXIsIGNhbGxiYWNrO1xuXG4gIC8vIFNvYWsgdGhlIHZhbHVlIHRocm91Z2ggdGhlIGJ1ZmZlciBmaXJzdCwgZXZlbiBpZiB0aGVyZSBpcyBhXG4gIC8vIHBlbmRpbmcgdGFrZXIuIFRoaXMgd2F5IHRoZSBzdGVwIGZ1bmN0aW9uIGhhcyBhIGNoYW5jZSB0byBhY3Qgb24gdGhlXG4gIC8vIHZhbHVlLlxuICBpZiAodGhpcy5idWYgJiYgIXRoaXMuYnVmLmlzX2Z1bGwoKSkge1xuICAgIGhhbmRsZXIuY29tbWl0KCk7XG4gICAgdmFyIGRvbmUgPSBpc1JlZHVjZWQodGhpcy54Zm9ybVtcIkBAdHJhbnNkdWNlci9zdGVwXCJdKHRoaXMuYnVmLCB2YWx1ZSkpO1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBpZiAodGhpcy5idWYuY291bnQoKSA9PT0gMCkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHRha2VyID0gdGhpcy50YWtlcy5wb3AoKTtcbiAgICAgIGlmICh0YWtlciA9PT0gYnVmZmVycy5FTVBUWSkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmICh0YWtlci5pc19hY3RpdmUoKSkge1xuICAgICAgICB2YWx1ZSA9IHRoaXMuYnVmLnJlbW92ZSgpO1xuICAgICAgICBjYWxsYmFjayA9IHRha2VyLmNvbW1pdCgpO1xuICAgICAgICBzY2hlZHVsZShjYWxsYmFjaywgdmFsdWUpO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZG9uZSkge1xuICAgICAgdGhpcy5jbG9zZSgpO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IEJveCh0cnVlKTtcbiAgfVxuXG4gIC8vIEVpdGhlciB0aGUgYnVmZmVyIGlzIGZ1bGwsIGluIHdoaWNoIGNhc2UgdGhlcmUgd29uJ3QgYmUgYW55XG4gIC8vIHBlbmRpbmcgdGFrZXMsIG9yIHdlIGRvbid0IGhhdmUgYSBidWZmZXIsIGluIHdoaWNoIGNhc2UgdGhpcyBsb29wXG4gIC8vIGZ1bGZpbGxzIHRoZSBmaXJzdCBvZiB0aGVtIHRoYXQgaXMgYWN0aXZlIChub3RlIHRoYXQgd2UgZG9uJ3RcbiAgLy8gaGF2ZSB0byB3b3JyeSBhYm91dCB0cmFuc2R1Y2VycyBoZXJlIHNpbmNlIHdlIHJlcXVpcmUgYSBidWZmZXJcbiAgLy8gZm9yIHRoYXQpLlxuICB3aGlsZSAodHJ1ZSkge1xuICAgIHRha2VyID0gdGhpcy50YWtlcy5wb3AoKTtcbiAgICBpZiAodGFrZXIgPT09IGJ1ZmZlcnMuRU1QVFkpIHtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBpZiAodGFrZXIuaXNfYWN0aXZlKCkpIHtcbiAgICAgIGhhbmRsZXIuY29tbWl0KCk7XG4gICAgICBjYWxsYmFjayA9IHRha2VyLmNvbW1pdCgpO1xuICAgICAgc2NoZWR1bGUoY2FsbGJhY2ssIHZhbHVlKTtcbiAgICAgIHJldHVybiBuZXcgQm94KHRydWUpO1xuICAgIH1cbiAgfVxuXG4gIC8vIE5vIGJ1ZmZlciwgZnVsbCBidWZmZXIsIG5vIHBlbmRpbmcgdGFrZXMuIFF1ZXVlIHRoaXMgcHV0IG5vdy5cbiAgaWYgKHRoaXMuZGlydHlfcHV0cyA+IE1BWF9ESVJUWSkge1xuICAgIHRoaXMucHV0cy5jbGVhbnVwKGZ1bmN0aW9uKHB1dHRlcikge1xuICAgICAgcmV0dXJuIHB1dHRlci5oYW5kbGVyLmlzX2FjdGl2ZSgpO1xuICAgIH0pO1xuICAgIHRoaXMuZGlydHlfcHV0cyA9IDA7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5kaXJ0eV9wdXRzICsrO1xuICB9XG4gIGlmICh0aGlzLnB1dHMubGVuZ3RoID49IE1BWF9RVUVVRV9TSVpFKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gbW9yZSB0aGFuIFwiICsgTUFYX1FVRVVFX1NJWkUgKyBcIiBwZW5kaW5nIHB1dHMgYXJlIGFsbG93ZWQgb24gYSBzaW5nbGUgY2hhbm5lbC5cIik7XG4gIH1cbiAgdGhpcy5wdXRzLnVuYm91bmRlZF91bnNoaWZ0KG5ldyBQdXRCb3goaGFuZGxlciwgdmFsdWUpKTtcbiAgcmV0dXJuIG51bGw7XG59O1xuXG5DaGFubmVsLnByb3RvdHlwZS5fdGFrZSA9IGZ1bmN0aW9uKGhhbmRsZXIpIHtcbiAgaWYgKCFoYW5kbGVyLmlzX2FjdGl2ZSgpKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICB2YXIgcHV0dGVyLCBwdXRfaGFuZGxlciwgY2FsbGJhY2ssIHZhbHVlO1xuXG4gIGlmICh0aGlzLmJ1ZiAmJiB0aGlzLmJ1Zi5jb3VudCgpID4gMCkge1xuICAgIGhhbmRsZXIuY29tbWl0KCk7XG4gICAgdmFsdWUgPSB0aGlzLmJ1Zi5yZW1vdmUoKTtcbiAgICAvLyBXZSBuZWVkIHRvIGNoZWNrIHBlbmRpbmcgcHV0cyBoZXJlLCBvdGhlciB3aXNlIHRoZXkgd29uJ3RcbiAgICAvLyBiZSBhYmxlIHRvIHByb2NlZWQgdW50aWwgdGhlaXIgbnVtYmVyIHJlYWNoZXMgTUFYX0RJUlRZXG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGlmICh0aGlzLmJ1Zi5pc19mdWxsKCkpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBwdXR0ZXIgPSB0aGlzLnB1dHMucG9wKCk7XG4gICAgICBpZiAocHV0dGVyID09PSBidWZmZXJzLkVNUFRZKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgcHV0X2hhbmRsZXIgPSBwdXR0ZXIuaGFuZGxlcjtcbiAgICAgIGlmIChwdXRfaGFuZGxlci5pc19hY3RpdmUoKSkge1xuICAgICAgICBjYWxsYmFjayA9IHB1dF9oYW5kbGVyLmNvbW1pdCgpO1xuICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICBzY2hlZHVsZShjYWxsYmFjaywgdHJ1ZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzUmVkdWNlZCh0aGlzLnhmb3JtW1wiQEB0cmFuc2R1Y2VyL3N0ZXBcIl0odGhpcy5idWYsIHB1dHRlci52YWx1ZSkpKSB7XG4gICAgICAgICAgdGhpcy5jbG9zZSgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBuZXcgQm94KHZhbHVlKTtcbiAgfVxuXG4gIC8vIEVpdGhlciB0aGUgYnVmZmVyIGlzIGVtcHR5LCBpbiB3aGljaCBjYXNlIHRoZXJlIHdvbid0IGJlIGFueVxuICAvLyBwZW5kaW5nIHB1dHMsIG9yIHdlIGRvbid0IGhhdmUgYSBidWZmZXIsIGluIHdoaWNoIGNhc2UgdGhpcyBsb29wXG4gIC8vIGZ1bGZpbGxzIHRoZSBmaXJzdCBvZiB0aGVtIHRoYXQgaXMgYWN0aXZlIChub3RlIHRoYXQgd2UgZG9uJ3RcbiAgLy8gaGF2ZSB0byB3b3JyeSBhYm91dCB0cmFuc2R1Y2VycyBoZXJlIHNpbmNlIHdlIHJlcXVpcmUgYSBidWZmZXJcbiAgLy8gZm9yIHRoYXQpLlxuICB3aGlsZSAodHJ1ZSkge1xuICAgIHB1dHRlciA9IHRoaXMucHV0cy5wb3AoKTtcbiAgICB2YWx1ZSA9IHB1dHRlci52YWx1ZTtcbiAgICBpZiAocHV0dGVyID09PSBidWZmZXJzLkVNUFRZKSB7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgcHV0X2hhbmRsZXIgPSBwdXR0ZXIuaGFuZGxlcjtcbiAgICBpZiAocHV0X2hhbmRsZXIuaXNfYWN0aXZlKCkpIHtcbiAgICAgIGNhbGxiYWNrID0gcHV0X2hhbmRsZXIuY29tbWl0KCk7XG4gICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgc2NoZWR1bGUoY2FsbGJhY2ssIHRydWUpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG5ldyBCb3godmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIGlmICh0aGlzLmNsb3NlZCkge1xuICAgIGhhbmRsZXIuY29tbWl0KCk7XG4gICAgcmV0dXJuIG5ldyBCb3goQ0xPU0VEKTtcbiAgfVxuXG4gIC8vIE5vIGJ1ZmZlciwgZW1wdHkgYnVmZmVyLCBubyBwZW5kaW5nIHB1dHMuIFF1ZXVlIHRoaXMgdGFrZSBub3cuXG4gIGlmICh0aGlzLmRpcnR5X3Rha2VzID4gTUFYX0RJUlRZKSB7XG4gICAgdGhpcy50YWtlcy5jbGVhbnVwKGZ1bmN0aW9uKGhhbmRsZXIpIHtcbiAgICAgIHJldHVybiBoYW5kbGVyLmlzX2FjdGl2ZSgpO1xuICAgIH0pO1xuICAgIHRoaXMuZGlydHlfdGFrZXMgPSAwO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuZGlydHlfdGFrZXMgKys7XG4gIH1cbiAgaWYgKHRoaXMudGFrZXMubGVuZ3RoID49IE1BWF9RVUVVRV9TSVpFKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gbW9yZSB0aGFuIFwiICsgTUFYX1FVRVVFX1NJWkUgKyBcIiBwZW5kaW5nIHRha2VzIGFyZSBhbGxvd2VkIG9uIGEgc2luZ2xlIGNoYW5uZWwuXCIpO1xuICB9XG4gIHRoaXMudGFrZXMudW5ib3VuZGVkX3Vuc2hpZnQoaGFuZGxlcik7XG4gIHJldHVybiBudWxsO1xufTtcblxuQ2hhbm5lbC5wcm90b3R5cGUuY2xvc2UgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuY2xvc2VkKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRoaXMuY2xvc2VkID0gdHJ1ZTtcblxuICAvLyBUT0RPOiBEdXBsaWNhdGUgY29kZS4gTWFrZSBhIFwiX2ZsdXNoXCIgZnVuY3Rpb24gb3Igc29tZXRoaW5nXG4gIGlmICh0aGlzLmJ1Zikge1xuICAgIHRoaXMuYnVmLmNsb3NlKCk7XG4gICAgdGhpcy54Zm9ybVtcIkBAdHJhbnNkdWNlci9yZXN1bHRcIl0odGhpcy5idWYpO1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBpZiAodGhpcy5idWYuY291bnQoKSA9PT0gMCkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHRha2VyID0gdGhpcy50YWtlcy5wb3AoKTtcbiAgICAgIGlmICh0YWtlciA9PT0gYnVmZmVycy5FTVBUWSkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmICh0YWtlci5pc19hY3RpdmUoKSkge1xuICAgICAgICBjYWxsYmFjayA9IHRha2VyLmNvbW1pdCgpO1xuICAgICAgICB2YXIgdmFsdWUgPSB0aGlzLmJ1Zi5yZW1vdmUoKTtcbiAgICAgICAgc2NoZWR1bGUoY2FsbGJhY2ssIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICB3aGlsZSAodHJ1ZSkge1xuICAgIHZhciB0YWtlciA9IHRoaXMudGFrZXMucG9wKCk7XG4gICAgaWYgKHRha2VyID09PSBidWZmZXJzLkVNUFRZKSB7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgaWYgKHRha2VyLmlzX2FjdGl2ZSgpKSB7XG4gICAgICB2YXIgY2FsbGJhY2sgPSB0YWtlci5jb21taXQoKTtcbiAgICAgIHNjaGVkdWxlKGNhbGxiYWNrLCBDTE9TRUQpO1xuICAgIH1cbiAgfVxuXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgdmFyIHB1dHRlciA9IHRoaXMucHV0cy5wb3AoKTtcbiAgICBpZiAocHV0dGVyID09PSBidWZmZXJzLkVNUFRZKSB7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgaWYgKHB1dHRlci5oYW5kbGVyLmlzX2FjdGl2ZSgpKSB7XG4gICAgICB2YXIgcHV0X2NhbGxiYWNrID0gcHV0dGVyLmhhbmRsZXIuY29tbWl0KCk7XG4gICAgICBpZiAocHV0X2NhbGxiYWNrKSB7XG4gICAgICAgIHNjaGVkdWxlKHB1dF9jYWxsYmFjaywgZmFsc2UpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuXG5DaGFubmVsLnByb3RvdHlwZS5pc19jbG9zZWQgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuY2xvc2VkO1xufTtcblxuZnVuY3Rpb24gZGVmYXVsdEhhbmRsZXIoZSkge1xuICBjb25zb2xlLmxvZygnZXJyb3IgaW4gY2hhbm5lbCB0cmFuc2Zvcm1lcicsIGUuc3RhY2spO1xuICByZXR1cm4gQ0xPU0VEO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVFeChidWYsIGV4SGFuZGxlciwgZSkge1xuICB2YXIgZGVmID0gKGV4SGFuZGxlciB8fCBkZWZhdWx0SGFuZGxlcikoZSk7XG4gIGlmIChkZWYgIT09IENMT1NFRCkge1xuICAgIGJ1Zi5hZGQoZGVmKTtcbiAgfVxuICByZXR1cm4gYnVmO1xufVxuXG4vLyBUaGUgYmFzZSB0cmFuc2Zvcm1lciBvYmplY3QgdG8gdXNlIHdpdGggdHJhbnNkdWNlcnNcbmZ1bmN0aW9uIEFkZFRyYW5zZm9ybWVyKCkge1xufVxuXG5BZGRUcmFuc2Zvcm1lci5wcm90b3R5cGVbXCJAQHRyYW5zZHVjZXIvaW5pdFwiXSA9IGZ1bmN0aW9uKCkge1xuICB0aHJvdyBuZXcgRXJyb3IoJ2luaXQgbm90IGF2YWlsYWJsZScpO1xufTtcblxuQWRkVHJhbnNmb3JtZXIucHJvdG90eXBlW1wiQEB0cmFuc2R1Y2VyL3Jlc3VsdFwiXSA9IGZ1bmN0aW9uKHYpIHtcbiAgcmV0dXJuIHY7XG59O1xuXG5BZGRUcmFuc2Zvcm1lci5wcm90b3R5cGVbXCJAQHRyYW5zZHVjZXIvc3RlcFwiXSA9IGZ1bmN0aW9uKGJ1ZmZlciwgaW5wdXQpIHtcbiAgYnVmZmVyLmFkZChpbnB1dCk7XG4gIHJldHVybiBidWZmZXI7XG59O1xuXG5cbmZ1bmN0aW9uIGhhbmRsZUV4Y2VwdGlvbihleEhhbmRsZXIpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKHhmb3JtKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIFwiQEB0cmFuc2R1Y2VyL3N0ZXBcIjogZnVuY3Rpb24oYnVmZmVyLCBpbnB1dCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiB4Zm9ybVtcIkBAdHJhbnNkdWNlci9zdGVwXCJdKGJ1ZmZlciwgaW5wdXQpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIGhhbmRsZUV4KGJ1ZmZlciwgZXhIYW5kbGVyLCBlKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIFwiQEB0cmFuc2R1Y2VyL3Jlc3VsdFwiOiBmdW5jdGlvbihidWZmZXIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXR1cm4geGZvcm1bXCJAQHRyYW5zZHVjZXIvcmVzdWx0XCJdKGJ1ZmZlcik7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICByZXR1cm4gaGFuZGxlRXgoYnVmZmVyLCBleEhhbmRsZXIsIGUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgfTtcbn1cblxuLy8gWFhYOiBUaGlzIGlzIGluY29uc2lzdGVudC4gV2Ugc2hvdWxkIGVpdGhlciBjYWxsIHRoZSByZWR1Y2luZ1xuLy8gZnVuY3Rpb24geGZvcm0sIG9yIGNhbGwgdGhlIHRyYW5zZHVjZXIgeGZvcm0sIG5vdCBib3RoXG5leHBvcnRzLmNoYW4gPSBmdW5jdGlvbihidWYsIHhmb3JtLCBleEhhbmRsZXIpIHtcbiAgaWYgKHhmb3JtKSB7XG4gICAgaWYgKCFidWYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk9ubHkgYnVmZmVyZWQgY2hhbm5lbHMgY2FuIHVzZSB0cmFuc2R1Y2Vyc1wiKTtcbiAgICB9XG5cbiAgICB4Zm9ybSA9IHhmb3JtKG5ldyBBZGRUcmFuc2Zvcm1lcigpKTtcbiAgfSBlbHNlIHtcbiAgICB4Zm9ybSA9IG5ldyBBZGRUcmFuc2Zvcm1lcigpO1xuICB9XG4gIHhmb3JtID0gaGFuZGxlRXhjZXB0aW9uKGV4SGFuZGxlcikoeGZvcm0pO1xuXG4gIHJldHVybiBuZXcgQ2hhbm5lbChidWZmZXJzLnJpbmcoMzIpLCBidWZmZXJzLnJpbmcoMzIpLCBidWYsIHhmb3JtKTtcbn07XG5cbmV4cG9ydHMuQm94ID0gQm94O1xuZXhwb3J0cy5DaGFubmVsID0gQ2hhbm5lbDtcbmV4cG9ydHMuQ0xPU0VEID0gQ0xPU0VEO1xuIiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbi8vIFRPRE86IFVzZSBwcm9jZXNzLm5leHRUaWNrIGlmIGl0J3MgYXZhaWxhYmxlIHNpbmNlIGl0J3MgbW9yZVxuLy8gZWZmaWNpZW50XG4vLyBodHRwOi8vaG93dG9ub2RlLm9yZy91bmRlcnN0YW5kaW5nLXByb2Nlc3MtbmV4dC10aWNrXG4vLyBNYXliZSB3ZSBkb24ndCBldmVuIG5lZWQgdG8gcXVldWUgb3Vyc2VsdmVzIGluIHRoYXQgY2FzZT9cblxuLy8gWFhYOiBCdXQgaHR0cDovL2Jsb2cubm9kZWpzLm9yZy8yMDEzLzAzLzExL25vZGUtdjAtMTAtMC1zdGFibGUvXG4vLyBMb29rcyBsaWtlIGl0IHdpbGwgYmxvdyB1cCB0aGUgc3RhY2sgKG9yIGlzIHRoYXQganVzdCBhYm91dFxuLy8gcHJlLWVtcHRpbmcgSU8gKGJ1dCB0aGF0J3MgYWxyZWFkeSBiYWQgZW5vdWdoIElNTyk/KVxuXG4vLyBMb29rcyBsaWtlXG4vLyBodHRwOi8vbm9kZWpzLm9yZy9hcGkvcHJvY2Vzcy5odG1sI3Byb2Nlc3NfcHJvY2Vzc19uZXh0dGlja19jYWxsYmFja1xuLy8gaXMgdGhlIGVxdWl2YWxlbnQgb2Ygb3VyIFRBU0tfQkFUQ0hfU0laRVxuXG52YXIgYnVmZmVycyA9IHJlcXVpcmUoXCIuL2J1ZmZlcnNcIik7XG5cbnZhciBUQVNLX0JBVENIX1NJWkUgPSAxMDI0O1xuXG52YXIgdGFza3MgPSBidWZmZXJzLnJpbmcoMzIpO1xudmFyIHJ1bm5pbmcgPSBmYWxzZTtcbnZhciBxdWV1ZWQgPSBmYWxzZTtcblxudmFyIHF1ZXVlX2Rpc3BhdGNoZXI7XG5cbmZ1bmN0aW9uIHByb2Nlc3NfbWVzc2FnZXMoKSB7XG4gIHJ1bm5pbmcgPSB0cnVlO1xuICBxdWV1ZWQgPSBmYWxzZTtcbiAgdmFyIGNvdW50ID0gMDtcbiAgd2hpbGUgKHRydWUpIHtcbiAgICB2YXIgdGFzayA9IHRhc2tzLnBvcCgpO1xuICAgIGlmICh0YXNrID09PSBidWZmZXJzLkVNUFRZKSB7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgLy8gVE9ETzogRG9uJ3Qgd2UgbmVlZCBhIHRyeS9maW5hbGx5IGhlcmU/XG4gICAgdGFzaygpO1xuICAgIGlmIChjb3VudCA+PSBUQVNLX0JBVENIX1NJWkUpIHtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjb3VudCArKztcbiAgfVxuICBydW5uaW5nID0gZmFsc2U7XG4gIGlmICh0YXNrcy5sZW5ndGggPiAwKSB7XG4gICAgcXVldWVfZGlzcGF0Y2hlcigpO1xuICB9XG59XG5cbmlmICh0eXBlb2YgTWVzc2FnZUNoYW5uZWwgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgdmFyIG1lc3NhZ2VfY2hhbm5lbCA9IG5ldyBNZXNzYWdlQ2hhbm5lbCgpO1xuICBtZXNzYWdlX2NoYW5uZWwucG9ydDEub25tZXNzYWdlID0gZnVuY3Rpb24oXykge1xuICAgIHByb2Nlc3NfbWVzc2FnZXMoKTtcbiAgfTtcbiAgcXVldWVfZGlzcGF0Y2hlciA9IGZ1bmN0aW9uKCkgIHtcbiAgICBpZiAoIShxdWV1ZWQgJiYgcnVubmluZykpIHtcbiAgICAgIHF1ZXVlZCA9IHRydWU7XG4gICAgICBtZXNzYWdlX2NoYW5uZWwucG9ydDIucG9zdE1lc3NhZ2UoMCk7XG4gICAgfVxuICB9O1xufSBlbHNlIGlmICh0eXBlb2Ygc2V0SW1tZWRpYXRlICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gIHF1ZXVlX2Rpc3BhdGNoZXIgPSBmdW5jdGlvbigpIHtcbiAgICBpZiAoIShxdWV1ZWQgJiYgcnVubmluZykpIHtcbiAgICAgIHF1ZXVlZCA9IHRydWU7XG4gICAgICBzZXRJbW1lZGlhdGUocHJvY2Vzc19tZXNzYWdlcyk7XG4gICAgfVxuICB9O1xufSBlbHNlIHtcbiAgcXVldWVfZGlzcGF0Y2hlciA9IGZ1bmN0aW9uKCkge1xuICAgIGlmICghKHF1ZXVlZCAmJiBydW5uaW5nKSkge1xuICAgICAgcXVldWVkID0gdHJ1ZTtcbiAgICAgIHNldFRpbWVvdXQocHJvY2Vzc19tZXNzYWdlcywgMCk7XG4gICAgfVxuICB9O1xufVxuXG5leHBvcnRzLnJ1biA9IGZ1bmN0aW9uIChmKSB7XG4gIHRhc2tzLnVuYm91bmRlZF91bnNoaWZ0KGYpO1xuICBxdWV1ZV9kaXNwYXRjaGVyKCk7XG59O1xuXG5leHBvcnRzLnF1ZXVlX2RlbGF5ID0gZnVuY3Rpb24oZiwgZGVsYXkpIHtcbiAgc2V0VGltZW91dChmLCBkZWxheSk7XG59O1xuIiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbnZhciBkaXNwYXRjaCA9IHJlcXVpcmUoXCIuL2Rpc3BhdGNoXCIpO1xudmFyIHNlbGVjdCA9IHJlcXVpcmUoXCIuL3NlbGVjdFwiKTtcbnZhciBDaGFubmVsID0gcmVxdWlyZShcIi4vY2hhbm5lbHNcIikuQ2hhbm5lbDtcblxudmFyIEZuSGFuZGxlciA9IGZ1bmN0aW9uKGYpIHtcbiAgdGhpcy5mID0gZjtcbn07XG5cbkZuSGFuZGxlci5wcm90b3R5cGUuaXNfYWN0aXZlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0cnVlO1xufTtcblxuRm5IYW5kbGVyLnByb3RvdHlwZS5jb21taXQgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuZjtcbn07XG5cbmZ1bmN0aW9uIHB1dF90aGVuX2NhbGxiYWNrKGNoYW5uZWwsIHZhbHVlLCBjYWxsYmFjaykge1xuICB2YXIgcmVzdWx0ID0gY2hhbm5lbC5fcHV0KHZhbHVlLCBuZXcgRm5IYW5kbGVyKGNhbGxiYWNrKSk7XG4gIGlmIChyZXN1bHQgJiYgY2FsbGJhY2spIHtcbiAgICBjYWxsYmFjayhyZXN1bHQudmFsdWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHRha2VfdGhlbl9jYWxsYmFjayhjaGFubmVsLCBjYWxsYmFjaykge1xuICB2YXIgcmVzdWx0ID0gY2hhbm5lbC5fdGFrZShuZXcgRm5IYW5kbGVyKGNhbGxiYWNrKSk7XG4gIGlmIChyZXN1bHQpIHtcbiAgICBjYWxsYmFjayhyZXN1bHQudmFsdWUpO1xuICB9XG59XG5cbnZhciBQcm9jZXNzID0gZnVuY3Rpb24oZ2VuLCBvbkZpbmlzaCwgY3JlYXRvcikge1xuICB0aGlzLmdlbiA9IGdlbjtcbiAgdGhpcy5jcmVhdG9yRnVuYyA9IGNyZWF0b3I7XG4gIHRoaXMuZmluaXNoZWQgPSBmYWxzZTtcbiAgdGhpcy5vbkZpbmlzaCA9IG9uRmluaXNoO1xufTtcblxudmFyIEluc3RydWN0aW9uID0gZnVuY3Rpb24ob3AsIGRhdGEpIHtcbiAgdGhpcy5vcCA9IG9wO1xuICB0aGlzLmRhdGEgPSBkYXRhO1xufTtcblxudmFyIFRBS0UgPSBcInRha2VcIjtcbnZhciBQVVQgPSBcInB1dFwiO1xudmFyIFNMRUVQID0gXCJzbGVlcFwiO1xudmFyIEFMVFMgPSBcImFsdHNcIjtcblxuLy8gVE9ETyBGSVggWFhYOiBUaGlzIGlzIGEgKHByb2JhYmx5KSB0ZW1wb3JhcnkgaGFjayB0byBhdm9pZCBibG93aW5nXG4vLyB1cCB0aGUgc3RhY2ssIGJ1dCBpdCBtZWFucyBkb3VibGUgcXVldWVpbmcgd2hlbiB0aGUgdmFsdWUgaXMgbm90XG4vLyBpbW1lZGlhdGVseSBhdmFpbGFibGVcblByb2Nlc3MucHJvdG90eXBlLl9jb250aW51ZSA9IGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgZGlzcGF0Y2gucnVuKGZ1bmN0aW9uKCkge1xuICAgIHNlbGYucnVuKHJlc3BvbnNlKTtcbiAgfSk7XG59O1xuXG5Qcm9jZXNzLnByb3RvdHlwZS5fZG9uZSA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gIGlmICghdGhpcy5maW5pc2hlZCkge1xuICAgIHRoaXMuZmluaXNoZWQgPSB0cnVlO1xuICAgIHZhciBvbkZpbmlzaCA9IHRoaXMub25GaW5pc2g7XG4gICAgaWYgKHR5cGVvZiBvbkZpbmlzaCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICBkaXNwYXRjaC5ydW4oZnVuY3Rpb24oKSB7XG4gICAgICAgIG9uRmluaXNoKHZhbHVlKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufTtcblxuUHJvY2Vzcy5wcm90b3R5cGUucnVuID0gZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgaWYgKHRoaXMuZmluaXNoZWQpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUT0RPOiBTaG91bGRuJ3Qgd2UgKG9wdGlvbmFsbHkpIHN0b3AgZXJyb3IgcHJvcGFnYXRpb24gaGVyZSAoYW5kXG4gIC8vIHNpZ25hbCB0aGUgZXJyb3IgdGhyb3VnaCBhIGNoYW5uZWwgb3Igc29tZXRoaW5nKT8gT3RoZXJ3aXNlIHRoZVxuICAvLyB1bmNhdWdodCBleGNlcHRpb24gd2lsbCBjcmFzaCBzb21lIHJ1bnRpbWVzIChlLmcuIE5vZGUpXG4gIHZhciBpdGVyID0gdGhpcy5nZW4ubmV4dChyZXNwb25zZSk7XG4gIGlmIChpdGVyLmRvbmUpIHtcbiAgICB0aGlzLl9kb25lKGl0ZXIudmFsdWUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBpbnMgPSBpdGVyLnZhbHVlO1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKGlucyBpbnN0YW5jZW9mIEluc3RydWN0aW9uKSB7XG4gICAgc3dpdGNoIChpbnMub3ApIHtcbiAgICBjYXNlIFBVVDpcbiAgICAgIHZhciBkYXRhID0gaW5zLmRhdGE7XG4gICAgICBwdXRfdGhlbl9jYWxsYmFjayhkYXRhLmNoYW5uZWwsIGRhdGEudmFsdWUsIGZ1bmN0aW9uKG9rKSB7XG4gICAgICAgIHNlbGYuX2NvbnRpbnVlKG9rKTtcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFRBS0U6XG4gICAgICB2YXIgY2hhbm5lbCA9IGlucy5kYXRhO1xuICAgICAgdGFrZV90aGVuX2NhbGxiYWNrKGNoYW5uZWwsIGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgIHNlbGYuX2NvbnRpbnVlKHZhbHVlKTtcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFNMRUVQOlxuICAgICAgdmFyIG1zZWNzID0gaW5zLmRhdGE7XG4gICAgICBkaXNwYXRjaC5xdWV1ZV9kZWxheShmdW5jdGlvbigpIHtcbiAgICAgICAgc2VsZi5ydW4obnVsbCk7XG4gICAgICB9LCBtc2Vjcyk7XG4gICAgICBicmVhaztcblxuICAgIGNhc2UgQUxUUzpcbiAgICAgIHNlbGVjdC5kb19hbHRzKGlucy5kYXRhLm9wZXJhdGlvbnMsIGZ1bmN0aW9uKHJlc3VsdCkge1xuICAgICAgICBzZWxmLl9jb250aW51ZShyZXN1bHQpO1xuICAgICAgfSwgaW5zLmRhdGEub3B0aW9ucyk7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgZWxzZSBpZihpbnMgaW5zdGFuY2VvZiBDaGFubmVsKSB7XG4gICAgdmFyIGNoYW5uZWwgPSBpbnM7XG4gICAgdGFrZV90aGVuX2NhbGxiYWNrKGNoYW5uZWwsIGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICBzZWxmLl9jb250aW51ZSh2YWx1ZSk7XG4gICAgfSk7XG4gIH1cbiAgZWxzZSB7XG4gICAgdGhpcy5fY29udGludWUoaW5zKTtcbiAgfVxufTtcblxuZnVuY3Rpb24gdGFrZShjaGFubmVsKSB7XG4gIHJldHVybiBuZXcgSW5zdHJ1Y3Rpb24oVEFLRSwgY2hhbm5lbCk7XG59XG5cbmZ1bmN0aW9uIHB1dChjaGFubmVsLCB2YWx1ZSkge1xuICByZXR1cm4gbmV3IEluc3RydWN0aW9uKFBVVCwge1xuICAgIGNoYW5uZWw6IGNoYW5uZWwsXG4gICAgdmFsdWU6IHZhbHVlXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBzbGVlcChtc2Vjcykge1xuICByZXR1cm4gbmV3IEluc3RydWN0aW9uKFNMRUVQLCBtc2Vjcyk7XG59XG5cbmZ1bmN0aW9uIGFsdHMob3BlcmF0aW9ucywgb3B0aW9ucykge1xuICByZXR1cm4gbmV3IEluc3RydWN0aW9uKEFMVFMsIHtcbiAgICBvcGVyYXRpb25zOiBvcGVyYXRpb25zLFxuICAgIG9wdGlvbnM6IG9wdGlvbnNcbiAgfSk7XG59XG5cbmV4cG9ydHMucHV0X3RoZW5fY2FsbGJhY2sgPSBwdXRfdGhlbl9jYWxsYmFjaztcbmV4cG9ydHMudGFrZV90aGVuX2NhbGxiYWNrID0gdGFrZV90aGVuX2NhbGxiYWNrO1xuZXhwb3J0cy5wdXQgPSBwdXQ7XG5leHBvcnRzLnRha2UgPSB0YWtlO1xuZXhwb3J0cy5zbGVlcCA9IHNsZWVwO1xuZXhwb3J0cy5hbHRzID0gYWx0cztcblxuZXhwb3J0cy5Qcm9jZXNzID0gUHJvY2VzcztcbiIsIlwidXNlIHN0cmljdFwiO1xuXG52YXIgQm94ID0gcmVxdWlyZShcIi4vY2hhbm5lbHNcIikuQm94O1xuXG52YXIgQWx0SGFuZGxlciA9IGZ1bmN0aW9uKGZsYWcsIGYpIHtcbiAgdGhpcy5mID0gZjtcbiAgdGhpcy5mbGFnID0gZmxhZztcbn07XG5cbkFsdEhhbmRsZXIucHJvdG90eXBlLmlzX2FjdGl2ZSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5mbGFnLnZhbHVlO1xufTtcblxuQWx0SGFuZGxlci5wcm90b3R5cGUuY29tbWl0ID0gZnVuY3Rpb24oKSB7XG4gIHRoaXMuZmxhZy52YWx1ZSA9IGZhbHNlO1xuICByZXR1cm4gdGhpcy5mO1xufTtcblxudmFyIEFsdFJlc3VsdCA9IGZ1bmN0aW9uKHZhbHVlLCBjaGFubmVsKSB7XG4gIHRoaXMudmFsdWUgPSB2YWx1ZTtcbiAgdGhpcy5jaGFubmVsID0gY2hhbm5lbDtcbn07XG5cbmZ1bmN0aW9uIHJhbmRfaW50KG4pIHtcbiAgcmV0dXJuIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIChuICsgMSkpO1xufVxuXG5mdW5jdGlvbiByYW5kb21fYXJyYXkobikge1xuICB2YXIgYSA9IG5ldyBBcnJheShuKTtcbiAgdmFyIGk7XG4gIGZvciAoaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICBhW2ldID0gMDtcbiAgfVxuICBmb3IgKGkgPSAxOyBpIDwgbjsgaSsrKSB7XG4gICAgdmFyIGogPSByYW5kX2ludChpKTtcbiAgICBhW2ldID0gYVtqXTtcbiAgICBhW2pdID0gaTtcbiAgfVxuICByZXR1cm4gYTtcbn1cblxudmFyIGhhc093blByb3BlcnR5ID0gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eTtcblxudmFyIERFRkFVTFQgPSB7XG4gIHRvU3RyaW5nOiBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gXCJbb2JqZWN0IERFRkFVTFRdXCI7XG4gIH1cbn07XG5cbi8vIFRPRE86IEFjY2VwdCBhIHByaW9yaXR5IGZ1bmN0aW9uIG9yIHNvbWV0aGluZ1xuZXhwb3J0cy5kb19hbHRzID0gZnVuY3Rpb24ob3BlcmF0aW9ucywgY2FsbGJhY2ssIG9wdGlvbnMpIHtcbiAgdmFyIGxlbmd0aCA9IG9wZXJhdGlvbnMubGVuZ3RoO1xuICAvLyBYWFggSG1tXG4gIGlmIChsZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJFbXB0eSBhbHQgbGlzdFwiKTtcbiAgfVxuXG4gIHZhciBwcmlvcml0eSA9IChvcHRpb25zICYmIG9wdGlvbnMucHJpb3JpdHkpID8gdHJ1ZSA6IGZhbHNlO1xuICBpZiAoIXByaW9yaXR5KSB7XG4gICAgdmFyIGluZGV4ZXMgPSByYW5kb21fYXJyYXkobGVuZ3RoKTtcbiAgfVxuXG4gIHZhciBmbGFnID0gbmV3IEJveCh0cnVlKTtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIG9wZXJhdGlvbiA9IG9wZXJhdGlvbnNbcHJpb3JpdHkgPyBpIDogaW5kZXhlc1tpXV07XG4gICAgdmFyIHBvcnQsIHJlc3VsdDtcbiAgICAvLyBYWFggSG1tXG4gICAgaWYgKG9wZXJhdGlvbiBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICB2YXIgdmFsdWUgPSBvcGVyYXRpb25bMV07XG4gICAgICBwb3J0ID0gb3BlcmF0aW9uWzBdO1xuICAgICAgLy8gV2Ugd3JhcCB0aGlzIGluIGEgZnVuY3Rpb24gdG8gY2FwdHVyZSB0aGUgdmFsdWUgb2YgXCJwb3J0XCIsXG4gICAgICAvLyBiZWNhdXNlIGpzJyBjbG9zdXJlIGNhcHR1cmVzIHZhcnMgYnkgXCJyZWZlcmVuY2VzXCIsIG5vdFxuICAgICAgLy8gdmFsdWVzLiBcImxldCBwb3J0XCIgd291bGQgaGF2ZSB3b3JrZWQsIGJ1dCBJIGRvbid0IHdhbnQgdG9cbiAgICAgIC8vIHJhaXNlIHRoZSBydW50aW1lIHJlcXVpcmVtZW50IHlldC4gVE9ETzogU28gY2hhbmdlIHRoaXMgd2hlblxuICAgICAgLy8gbW9zdCBydW50aW1lcyBhcmUgbW9kZXJuIGVub3VnaC5cbiAgICAgIHJlc3VsdCA9IHBvcnQuX3B1dCh2YWx1ZSwgKGZ1bmN0aW9uKHBvcnQpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBBbHRIYW5kbGVyKGZsYWcsIGZ1bmN0aW9uKG9rKSB7XG4gICAgICAgICAgY2FsbGJhY2sobmV3IEFsdFJlc3VsdChvaywgcG9ydCkpO1xuICAgICAgICB9KTtcbiAgICAgIH0pKHBvcnQpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcG9ydCA9IG9wZXJhdGlvbjtcbiAgICAgIHJlc3VsdCA9IHBvcnQuX3Rha2UoKGZ1bmN0aW9uKHBvcnQpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBBbHRIYW5kbGVyKGZsYWcsIGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgICAgY2FsbGJhY2sobmV3IEFsdFJlc3VsdCh2YWx1ZSwgcG9ydCkpO1xuICAgICAgICB9KTtcbiAgICAgIH0pKHBvcnQpKTtcbiAgICB9XG4gICAgLy8gWFhYIEhtbVxuICAgIGlmIChyZXN1bHQgaW5zdGFuY2VvZiBCb3gpIHtcbiAgICAgIGNhbGxiYWNrKG5ldyBBbHRSZXN1bHQocmVzdWx0LnZhbHVlLCBwb3J0KSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAoIShyZXN1bHQgaW5zdGFuY2VvZiBCb3gpXG4gICAgICAmJiBvcHRpb25zXG4gICAgICAmJiBoYXNPd25Qcm9wZXJ0eS5jYWxsKG9wdGlvbnMsIFwiZGVmYXVsdFwiKSkge1xuICAgIGlmIChmbGFnLnZhbHVlKSB7XG4gICAgICBmbGFnLnZhbHVlID0gZmFsc2U7XG4gICAgICBjYWxsYmFjayhuZXcgQWx0UmVzdWx0KG9wdGlvbnNbXCJkZWZhdWx0XCJdLCBERUZBVUxUKSk7XG4gICAgfVxuICB9XG59O1xuXG5leHBvcnRzLkRFRkFVTFQgPSBERUZBVUxUO1xuIiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbnZhciBkaXNwYXRjaCA9IHJlcXVpcmUoXCIuL2Rpc3BhdGNoXCIpO1xudmFyIGNoYW5uZWxzID0gcmVxdWlyZShcIi4vY2hhbm5lbHNcIik7XG5cbmV4cG9ydHMudGltZW91dCA9IGZ1bmN0aW9uIHRpbWVvdXRfY2hhbm5lbChtc2Vjcykge1xuICB2YXIgY2hhbiA9IGNoYW5uZWxzLmNoYW4oKTtcbiAgZGlzcGF0Y2gucXVldWVfZGVsYXkoZnVuY3Rpb24oKSB7XG4gICAgY2hhbi5jbG9zZSgpO1xuICB9LCBtc2Vjcyk7XG4gIHJldHVybiBjaGFuO1xufTtcbiIsImltcG9ydCBjc3AgZnJvbSAnanMtY3NwJztcblxud2luZG93LmNzcCA9IGNzcDtcbiJdfQ==

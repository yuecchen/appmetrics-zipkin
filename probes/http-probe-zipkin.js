/*******************************************************************************
 * Copyright 2017 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *******************************************************************************/
'use strict';

var Probe = require('../lib/probe.js');
var aspect = require('../lib/aspect.js');
var tool = require('../lib/tools.js');
var util = require('util');
const zipkin = require('zipkin');
var log4js = require('log4js');
var logger = log4js.getLogger('knj_log');

var serviceName;
var ibmapmContext;
var tracer;

const {
  Request,
  HttpHeaders: Header,
  option: {
    Some,
    None
  },
  Annotation,
  TraceId
} = require('zipkin');

const CLSContext = require('zipkin-context-cls');
const ctxImpl = new CLSContext();

function hasZipkinHeader(httpReq) {
  const headers = httpReq.headers || {};
  return headers[(Header.TraceId).toLowerCase()] !== undefined && headers[(Header.SpanId).toLowerCase()] !== undefined;
}

function HttpProbeZipkin() {
  Probe.call(this, 'http');
  this.config = {
    filters: []
  };
}
util.inherits(HttpProbeZipkin, Probe);


function stringToBoolean(str) {
  return str === '1';
}

function stringToIntOption(str) {
  try {
    // eslint-disable-next-line radix
    return new Some(parseInt(str, 10));
  } catch (err) {
    return None;
  }
}

HttpProbeZipkin.prototype.updateProbes = function() {
  serviceName = this.serviceName;
  ibmapmContext = this.ibmapmContext;
  tracer = new zipkin.Tracer({
    ctxImpl,
    recorder: this.recorder,
    sampler: new zipkin.sampler.CountingSampler(this.config.sampleRate),
        // sample rate 0.01 will sample 1 % of all incoming requests
    traceId128Bit: true // to generate 128-bit trace IDs.
  });
};

HttpProbeZipkin.prototype.attach = function(name, target) {
  serviceName = this.serviceName;

  tracer = new zipkin.Tracer({
    ctxImpl,
    recorder: this.recorder,
    sampler: new zipkin.sampler.CountingSampler(this.config.sampleRate),
        // sample rate 0.01 will sample 1 % of all incoming requests
    traceId128Bit: true // to generate 128-bit trace IDs.
  });

  if (name === 'http') {
    if (target.__zipkinProbeAttached__) return target;
    target.__zipkinProbeAttached__ = true;
    var methods = ['on', 'addListener'];

    aspect.before(target.Server.prototype, methods,
      function(obj, methodName, args, probeData) {
        if (args[0] !== 'request') return;
        if (obj.__zipkinhttpProbe__) return;
        obj.__zipkinhttpProbe__ = true;
        aspect.aroundCallback(args, probeData, function(obj, args, probeData) {
          if (process.env.JAEGER_ENDPOINT_NOTREADY === 'true'){
            return;
          }
          var httpReq = args[0];
          var res = args[1];
          var childId;
          // Filter out urls where filter.to is ''
          var traceUrl = parse(httpReq.url);
          if (traceUrl !== '') {
            var reqMethod = httpReq.method;
            var edgeRequest = false;
            if (reqMethod.toUpperCase() === 'OPTIONS' && httpReq.headers['access-control-request-method']) {
              reqMethod = httpReq.headers['access-control-request-method'];
            }
            if (hasZipkinHeader(httpReq)) {
              const headers = httpReq.headers;
              var spanId = headers[(Header.SpanId).toLowerCase()];
              if (spanId !== undefined) {
                const traceId = new Some(headers[(Header.TraceId).toLowerCase()]);
                const parentSpanId = new Some(headers[(Header.ParentSpanId).toLowerCase()]);
                const sampled = new Some(headers[(Header.Sampled).toLowerCase()]);
                const flags = (new Some(headers[(Header.Flags).toLowerCase()])).flatMap(stringToIntOption).getOrElse(0);
                var id = new TraceId({
                  traceId: traceId,
                  parentId: parentSpanId,
                  spanId: spanId,
                  sampled: sampled.map(stringToBoolean),
                  flags
                });
                tracer.setId(id);
                childId = tracer.createChildId();
                tracer.setId(childId);
                probeData.traceId = tracer.id;
              };
            } else {
              edgeRequest = true;
              tracer.setId(tracer.createRootId());
              probeData.traceId = tracer.id;
              // Must assign new options back to args[0]
              const { headers } = Request.addZipkinHeaders(args[0], tracer.id);
              Object.assign(args[0].headers, headers);
            }

            var urlPrefix = 'http://' + httpReq.headers.host;
            var maxUrlLength = global.KNJ_TT_MAX_LENGTH;
            if (urlPrefix.length < global.KNJ_TT_MAX_LENGTH) {
              maxUrlLength = global.KNJ_TT_MAX_LENGTH - urlPrefix.length;
            } else {
              maxUrlLength = 1;
            }
            if (traceUrl.length > maxUrlLength) {
              traceUrl = traceUrl.substr(0, maxUrlLength);
            }

            tracer.recordBinary('http.url', urlPrefix + traceUrl);
            tracer.recordAnnotation(new Annotation.ServerRecv());
            logger.debug('http-tracer(before): ', tracer.id);
            aspect.after(res, 'end', probeData, function(obj, methodName, args, probeData, ret) {
              tracer.setId(probeData.traceId);
              tracer.recordServiceName(serviceName);
              tracer.recordBinary('service.name', serviceName);
              tracer.recordRpc(traceUrl);
              tracer.recordAnnotation(new Annotation.LocalAddr(0));
              var status_code = res.statusCode.toString();
              tracer.recordBinary('http.status_code', status_code);
              if (status_code >= 400) {
                tracer.recordBinary('error', 'true');
              }
              tracer.recordBinary('http.method', reqMethod.toUpperCase());
              if (process.env.APM_TENANT_ID){
                tracer.recordBinary('tenant.id', process.env.APM_TENANT_ID);
              }
              tracer.recordBinary('edge.request', '' + edgeRequest);
              tracer.recordBinary('request.type', 'http');
              tool.recordIbmapmContext(tracer, ibmapmContext);
              tracer.recordAnnotation(new Annotation.ServerSend());
              logger.debug('http-tracer(after): ', tracer.id);
            });
          }
        });
      });
  }
  return target;
};
/*
 * Custom req.url parser that strips out any trailing query
 */
function parse(url) {
  ['?', '#'].forEach(function(separator) {
    var index = url.indexOf(separator);
    if (index !== -1) url = url.substring(0, index);
  });
  return url;
};

module.exports = HttpProbeZipkin;

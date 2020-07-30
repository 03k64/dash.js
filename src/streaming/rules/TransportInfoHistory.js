/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2017, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import FactoryMaker from '../../core/FactoryMaker';

function TransportInfoHistory(config) {
    config = config || {};

    const HEADER_KEYS = ['Transport-Info', 'transport-info'];
    const FIELD_PARSERS = {
        cwnd: parseInt,
        dstport: parseInt,
        mss: parseInt,
        rcv_space: parseInt,
        rtt: parseFloat,
        rttvar: parseFloat,
        send_rate: parseFloat,
        ts: Date.parse
    };
    const MAX_MEASUREMENTS_TO_KEEP = 100;

    let cwndDict,
        rttDict,
        transportInfoDict;

    function reset() {
        cwndDict = {};
        rttDict = {};
        transportInfoDict = {};
    }

    function setup() {
        reset();
    }

    function parseUnmodified(value) {
        return value;
    }

    function getTransportInfoHeader(headers) {
        if (headers === null || headers === undefined) {
            return;
        }

        const key = HEADER_KEYS.map(key => headers.hasOwnProperty(key));
        if (key === null || key === undefined) {
            return;
        }

        return headers[key];
    }

    function consumeTransportInfoField(transportInfoEntry, transportInfoField) {
        // Split into key, value pair, handling case that value contains one or more '=' characters
        const [key, ...values] = transportInfoField.split('=');
        const value = values.join('=');

        const parse = FIELD_PARSERS[key] || parseUnmodified;
        transportInfoEntry[key] = parse(value);

        return transportInfoEntry;
    }

    function parseTransportInfoEntry(transportInfoEntry) {
        let tiEntry = {};

        // Each entry should contain at least two fields, the machine identifier and a timestamp.
        // These and other optional fields are separated by a semi-colon.
        const tiEntryFields = transportInfoEntry.split(';');

        // TODO: properly find machine identifier in tiEntryFields
        tiEntry.machineId = tiEntryFields.shift();
        tiEntry = tiEntryFields.reduce(consumeTransportInfoField, tiEntry);

        if (tiEntry.ts === null || tiEntry.ts === undefined) {
            return;
        }

        return tiEntry;
    }

    function parseTransportInfoHeader(headers) {
        const transportInfo = getTransportInfoHeader(headers);
        if (transportInfo === null || transportInfo === undefined) {
            return;
        }

        // The header may contain multiple entries, separated by a comma, representing measurements
        // taken at multiple distinct timestamps, parse each individually and return an array,
        // filtering those that could not be parsed correctly
        return transportInfo
              .split(',')
              .map(parseTransportInfoEntry)
              .filter(tiEntry => tiEntry !== null && tiEntry !== undefined);
    }

    function push(mediaType, httpRequest) {
        const transportInfo = parseTransportInfoHeader(httpRequest._responseHeaders);
        if (transportInfo === null || transportInfo === undefined) {
            return;
        }

        // Ensure all dictionaries are initialised
        checkSettingsForMediaType(mediaType);

        // Extract any new cwnd measurements from parsed transport-info
        const newCwnd = transportInfo
              .map(tiEntry => tiEntry.cwnd)
              .filter(cwnd => cwnd !== null && cwnd !== undefined);

        // Extract any new rtt measurements from parsed transport-info
        const newRtt = transportInfo
              .map(tiEntry => tiEntry.rtt)
              .filter(rtt => rtt !== null && rtt !== undefined);

        // Append all new measurements to their respective dictionaries
        cwndDict.push(...newCwnd);
        rttDict.push(...newRtt);
        transportInfoDict.push(...transportInfo);

        // Ensure all new dictionaries are clamped to maximum size
        cwndDict = cwndDict.slice(-MAX_MEASUREMENTS_TO_KEEP);
        rttDict = rttDict.slice(-MAX_MEASUREMENTS_TO_KEEP);
        transportInfoDict = transportInfoDict.slice(-MAX_MEASUREMENTS_TO_KEEP);
    }

    function getAverageThroughput() {}

    function getAverageLatency() {}

    function checkSettingsForMediaType(mediaType) {
        cwndDict[mediaType] = cwndDict[mediaType] || [];
        rttDict[mediaType] = rttDict[mediaType] || [];
        transportInfoDict[mediaType] = transportInfoDict[mediaType] || [];
    }

    const instance = {
        push: push,
        getAverageThroughput: getAverageThroughput,
        getAverageLatency: getAverageLatency,
        reset: reset
    };

    setup();

    return instance;

    // rd-local; ts=2020-07-30T14:25:17.222Z; cwnd=10; rtt=23.864; rcv_space=14400; dstport=34294; rttvar=1100
}

TransportInfoHistory.__dashjs_factory_name = 'TransportInfoHistory';
export default FactoryMaker.getClassFactory(TransportInfoHistory);

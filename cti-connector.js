/*
  Copyright (C) 2015 Level 7 Systems Ltd.

  This software may be modified and distributed under the terms
  of the MIT license.  See the LICENSE file for details.
*/

var Cti = {
    EVENT: {
        READY: "READY",
        LOGGED_IN: "LOGGED_IN",
        LOGGED_OUT: "LOGGED_OUT",
        INITIAL: "INITIAL",
        ACCEPTED: "ACCEPTED",
        RINGING: "RINGING",
        CONNECTED: "CONNECTED",
        ON_HOLD: "ON_HOLD",
        HANGUP: "HUNGUP",
        CANCEL: "CANCEL",
        INFO: "INFO",
        ERROR: "ERROR"
    },
    DIRECTION: {
        IN: "INBOUND",
        OUT: "OUTBOUND"
    },
    /**
     * MESSAGES types
     */
    TYPE: {
        ERROR: "error",
        CHAT: "chat",
        HEADLINE: "headline",
        UNAVAILABLE: "unavailable"
    },
    /**
     * CALL statuses
     */
    CALL_STATUS: {
        INITIAL: "INITIAL",
        ACCEPTED: "ACCEPTED",
        RINGING: "RINGING",
        ON_HOLD: "ON_HOLD",
        CONNECTED: "CONNECTED",
        HANGUP: "HANGUP"
    },
    /**
     * CALL codes
     */
    CALL_CODE: {
        RINGING: /^1\d{2}$/,
        ACCEPTED: 200,
        REDIRECTED: /^3\d{2}$/,
        NO_ANSWER: 487,
        UNREACHABLE: 408,
        NOT_FOUND: /^4\d{2}$/,
        REJECTED: /^[5|6]\d{2}$/
    },
    log: function (message) {
        if (window.console) {
            if (typeof message === "string") {
                message = "Cti: " + message;
            }
            console.info(message);
        }
    }
};


Cti.Connector = function (options) {
    var me = this;

    if (typeof SIP == "undefined") {
        console.error('SIP dependency missing');
        return;
    }

    me.connected = false;

    me.apiEndpoint = "https://l7api.com/v1.1/voipstudio";
    
    me.callbacks = {
        onMessage: options.onMessage
    };

    if (me._hasActiveConnection()) {
        me._reconnect();
    }
};

Cti.Connector.prototype = {
    
    ua: null,
    subscriptions: {},
    calls: {},
    keepAliveTimer: null,

    /**
     * Returns boolean true if the client is currently connected.
     */
    isConnected: function () {
        this.log("isConnected() " + this.connected);
        return this.connected;
    },
    log: function (message) {
        if (window.console) {
            console.log("Cti.Connector: " + message);
        }
    },
    // authentication
    login: function () {
        var me = this;
        if (me.ua && this.ua.isConnected()) {
            me.log("Already connected");
            // mark as connected
            me.connected = true;
            // send LoggedOn event
            me._sendEvent({
                name: Cti.EVENT.LOGGED_IN,
                message: 'User is already authenticated.'
            });

            return;
        }
        
        if (arguments.length === 0 || arguments.length > 2) {
            me._sendErrorEvent("Invalid aruments number while login.");
            return;
        }

        var userId,
            apiKey,
            username,
            password;
        
        if (arguments.length == 1) {
            // authenticated via api_key
            var temp = arguments[0];
            temp = temp.split(":");
        
            if (temp.length !== 2) {
                me._sendErrorEvent("Invalid API Key format, please enter <user_id:api_key>.");
                return;
            }

            userId = temp[0];
            apiKey = temp[1];
        } else {
            // authenticate via login / password
            username = arguments[0],
            password = arguments[1];
        
            if (username.length === 0 || password.length === 0) {
                me._sendErrorEvent("Missing username and/or password.");
                return;
            }
        }

        var doLogin = function(credentials) {
            me._corsRequest({
                method: 'GET',
                url: '/me',
                credentials: credentials,
                success: function(response) {

                    me.log("ajax login SUCCESS");

                    me._setParam('user_id', credentials.user_id);
                    me._setParam('user_token', credentials.user_token);

                    // sucessfull login
                    me.connected = true;

                    // send LoggedOn event
                    me._sendEvent({
                        name: Cti.EVENT.LOGGED_IN,
                        message: 'User has been successfully authenticated.'
                    });

                    // connext to SIP server
                    me._connect(response.data.id, response.data.sip_password, response.data.sip_domain);

                },
                failure: function() {
                    me.log("ajax login FAIL - user data failure");
                    me._sendErrorEvent("Unable to login - user data failure");
                }
            });
        };

        if (apiKey) {
            doLogin({ user_id: userId, user_token: apiKey });
        } else {
            me._corsRequest({
                method: "POST",
                url: '/login',
                data: {
                    email: username,
                    password: password
                },
                success: function(response) {
                    if (!response.user_id || !response.user_token) {
                        me._sendErrorEvent('user_id and/or user_token missing in API response.');
                        return;
                    }

                    doLogin(response);
                },
                failure: function(status, response) {
                    me._sendErrorEvent(me.getApiError(response));
                }
            });
        }
    },
    logout: function () {
        var me = this;

        if (me.keepAliveTimer) {
            clearInterval(me.keepAliveTimer);
        }

        if (!me.isConnected()) {
            me._sendErrorEvent("Connector is not connected.");
            return;
        }

        me.apiRequest('POST', '/logout');

        me.connected = false;

        if (me.ua.isConnected()) {
            // terminates communications with the remote service provider
            me.ua.stop();
        }

        // cleanup
        me._setStorage('l7_connector', {});

        // send LoggedOut event
        return me._sendEvent({
            name: Cti.EVENT.LOGGED_OUT,
            message: 'User has been successfully logged out.'
        });
    },
    answer: function() {
        var me = this;

        if (!this.isConnected()) {
            me._sendErrorEvent("Connector need to be connected first.");
            return;
        }

        var callIdToAnswer = null;

        for (var id in me.calls) {
            var call = me.calls[id];

            if (call.direction == Cti.DIRECTION.IN && call.status == Cti.CALL_STATUS.RINGING) {
                callIdToAnswer = id;
            }
        }

        if (!callIdToAnswer) {
            me._sendErrorEvent("No ringing inbound calls to answer.");
            return;
        }

        me.apiRequest('PATCH', '/calls/' + callIdToAnswer, {
            state: 'CONNECTED'
        });
    },
    call: function (destination) {
        var me = this;
        if (!me.isConnected()) {
            me._sendErrorEvent("Connector need to be connected first.");
            return;
        }

        if (typeof destination === "undefined") {
            me._sendErrorEvent("Missing destination parameter");
            return;
        }

        if (destination.length === 0) {
            me._sendErrorEvent("Destination number is empty");
            return;
        }

        if (destination.length > 5) {
            // phone number
            destination = me._formatE164(destination);
            if (!me._isPhoneNumberValid(destination)) {
                me._sendErrorEvent("Phone number: " + destination + " has invalid format");
                return;
            }
        } else {
            // extension or spcial internal number
            if (me._getParam('sip_username') == destination) {
                me._sendErrorEvent("You are unable to call to yourme.");
                return;
            }
        }

        destination = destination.replace(/^\+/,"");

        var dt = new Date() / 1;

        var callId = 'initial-' + dt;

        var call = {
            id: callId,
            destination: destination,
            direction: Cti.DIRECTION.OUT,
            status: Cti.CALL_STATUS.INITIAL

        };

        me._sendEvent({
            name: Cti.EVENT.INITIAL,
            call: call
        });

        me.apiRequest('POST', '/calls', {
            to: destination
        }, function() {
            me._sendEvent({
                name: Cti.EVENT.ACCEPTED,
                call: call
            });
        }, function(status, response) {
            if (status == 400) {
                me._sendErrorEvent(me.getApiError(response));
            } else {

                var dtError = new Date() / 1;

                var diff = dtError - dt;

                if (diff < 1000) {
                    call.cause = 'SIP Endpoint not found';
                } else {
                    call.cause = 'SIP Endpoint rejected call';
                }
                me._sendEvent({
                    name: Cti.EVENT.CANCEL,
                    call: call
                });
            }
        });
    },
    terminate: function (callId) {
        var me = this;
        if (!me.isConnected()) {
            me._sendErrorEvent("Connector need to be connected first.");
            return;
        }

        if (typeof callId === "undefined") {
            me._sendErrorEvent("Missing call ID parameter");
            return;
        }

        if (!me.calls[callId]) {
            me._sendErrorEvent("Call with ID: " + callId + " could not be found.");
            return;
        }

        var call = me.calls[callId];

        // we can terminate calls only with status CONNECTED, ON_HOLD
        if ([Cti.CALL_STATUS.CONNECTED, Cti.CALL_STATUS.ON_HOLD].indexOf(call.status) == -1) {
            me._sendInfoEvent("Call with STATUS: " + call.status + " cannot be terminated.");
            return;
        }

        me.apiRequest('DELETE', '/calls/' + callId);
    },
    transfer: function (callId, destination) {
        var me = this;
        if (!me.isConnected()) {
            me._sendErrorEvent("Connector need to be connected first.");
            return;
        }

        if (typeof callId === "undefined") {
            me._sendErrorEvent("Missing call ID parameter");
            return;
        }

        if (typeof destination === "undefined") {
            me._sendErrorEvent("Missing destination parameter");
            return;
        }

        if (!me.calls[callId]) {
            me._sendErrorEvent("Call with ID: " + callId + " could not be found.");
            return;
        }

        var call = me.calls[callId];

        // we can transfer calls only with status COONNECTED
        if (call.status !== Cti.CALL_STATUS.CONNECTED) {
            me._sendInfoEvent("Call with STATUS: " + call.status + " cannot be transfered.");
            return;
        }

        if (destination.length === 0) {
            me._sendErrorEvent("Destination number is empty");
            return;
        }

        if (destination.length > 5) {
            // phone number
            destination = me._formatE164(destination);
            if (!me._isPhoneNumberValid(destination)) {
                me._sendErrorEvent("Phone number: " + destination + " has invalid format");
                return;
            }
        } else {
            // extension
            if (!me._isExtensionValid(destination)) {
                me._sendErrorEvent("Extension number: " + destination + " has invalid format");
                return;
            }

            if (me._getParam('sip_username') == destination) {
                me._sendErrorEvent("You are unable to transfer call to yourme.");
                return;
            }
        }

        // update call details
        me.calls[callId].destination = destination;

        me.apiRequest('PATCH', '/calls/' + callId, {
            dst: destination
        });
    },
    // subscribe to given node
    subscribe: function (node) {
        var me = this;
        if (typeof node === "undefined") {
            me._sendErrorEvent("Missing node parameter.");
            return;
        }
        
        if (!me.ua.isConnected()) {
            me._sendErrorEvent("Connector need to be connected first.");
            return;
        }
        
        var parts = node.split(':');
        if (parts.length != 2) {
            this._sendErrorEvent("Invalid node format.");
            return;
        }

        // available nodes
        var nodes = ['user', 'ivr', 'queue', 'conf'],
            node_type = parts.shift(),
            node_id = parts.shift();
        
        if (nodes.indexOf(node_type) < 0) {
            this._sendErrorEvent("Invalid node type.");
            return;
        }
        var subscribeNode;

        if (node_type == 'user') {
            subscribeNode = node_id;
        } else {
            subscribeNode = node_type + "-" + node_id;
        }

        var subscribeURI = subscribeNode + '@' + me._getParam('sip_domain');

        if (me.subscriptions[subscribeURI]) {
            me.log('Already subscribed to ['+subscribeURI+'], skipping...');
            return;
        }

        me.log('Cti.connector.subscribe ['+subscribeURI+']');

        var options = {
            expires: 300
        };

        var subscribe = me.ua.subscribe(subscribeURI, 'dialog', options);

        me.subscriptions[subscribeURI] = subscribe;

        subscribe.on('notify', function(notify) { 
            me.parseNotify(notify);
        });

        return subscribe;
    },
    apiRequest: function(method, url, data, successCb, failureCb) {
        var me = this;

        var cfg = {
            method: method,
            url: url,
            credentials: { user_id: me._getParam('user_id'), user_token: me._getParam('user_token') },
            success: function(response) {
                if (typeof successCb == 'function') {
                    successCb(response);
                }
            },
            failure: function(status, response) {

                if (typeof failureCb == 'function') {
                    failureCb(status, response);
                } else {
                    me._sendErrorEvent(me.getApiError(response));
                }
            }
        };

        if (data) {
            cfg.data = data;
        }

        me._corsRequest(cfg);
    },
    getApiError: function(response) {

        var errors = [];

        if (response.message) {
            errors.push(response.message);
        }

        if (response.errors) {
            for (var i = 0; i < response.errors.length; i++) {
                errors.push(response.errors[i].field + ': ' + response.errors[i].message);
            }
        }

        return (errors.length > 0) ? errors.join(" ") : "Unknown API Error";
    },
    parseNotify: function(notify) {
        var me = this;
        var parser = new DOMParser();
        var xmlDoc = parser.parseFromString(notify.request.body, "text/xml");

        var dialogs = xmlDoc.getElementsByTagName('dialog');

        for (var i = 0; i < dialogs.length; i++) { 
            var dialog = dialogs[i],
                temp = dialog.id.split("-");

            var call = { 
                id: temp[0],
                dialog_id: dialog.id,
                direction: null,
                state: null,
                remote: null,
                remote_name: null,
                local: null,
                local_name: null,
                context: null,
                duration: 0
            };

            call.direction = dialog.getAttribute('direction');

            if (dialog.getElementsByTagName('state').length) {
                call.state = dialog.getElementsByTagName('state')[0].childNodes[0].nodeValue;
            }

            var remotes = dialog.getElementsByTagName('remote');

            if (remotes.length) {

                var remote = remotes[0];

                if (remote.getElementsByTagName('identity').length) {
                    var remoteUri = remote.getElementsByTagName('identity')[0].childNodes[0].nodeValue;
                    call.remote_name = remote.getElementsByTagName('identity')[0].getAttribute('display').replace("&lt;","<").replace("&gt;", ">");
                    
                    temp = remoteUri.split('@');
                    call.remote = temp[0].substring(4);
                }
            }

            var locals = dialog.getElementsByTagName('local');

            if (locals.length) {

                var local = locals[0];

                if (local.getElementsByTagName('identity').length) {
                    var localUri = local.getElementsByTagName('identity')[0].childNodes[0].nodeValue;
                    call.local_name = local.getElementsByTagName('identity')[0].getAttribute('display').replace("&lt;","<").replace("&gt;", ">");
                    
                    temp = localUri.split('@');
                    call.local = temp[0].substring(4);
                }

                var params = local.getElementsByTagName('target')[0].getElementsByTagName('param');

                for (var j = 0; j < params.length; j++) {
                    var param = params[j];

                    var pname = param.getAttribute('pname');
                    var pval = param.getAttribute('pval');

                    if (pname == '+sip.rendering' && pval == 'no') {
                        call.state = 'onhold';
                    }

                    if (pname == 'timestamp.start') {
                        var d = new Date();
                        var seconds = Math.round(d.getTime() / 1000);
                        call.duration = seconds - parseInt(pval);
                    }

                    if (pname == 'context') {
                        call.context = pval;
                    }
                }
            }

            var ctiCall = {
                id: call.id,
                cid: call.dialog_id,
                cause: "",
                direction: (call.direction == "receiver") ? Cti.DIRECTION.IN : Cti.DIRECTION.OUT,
                destination: (call.direction == "receiver") ? call.local : call.remote,
                destinationName: (call.direction == "receiver") ? call.local_name : call.remote_name,
                source: (call.direction == "receiver") ? call.remote : call.local,
                sourceName: (call.direction == "receiver") ?  call.remote_name : call.local_name 
            };

            var event;

            if (call.state == 'confirmed') {
                ctiCall.status = Cti.CALL_STATUS.CONNECTED;
                event = Cti.EVENT.CONNECTED;
            }

            if (call.state == 'early') {
                ctiCall.status = Cti.CALL_STATUS.RINGING;
                event = Cti.EVENT.RINGING;
            }

            if (call.state == 'onhold') {
                ctiCall.status = Cti.CALL_STATUS.ON_HOLD;
                event = Cti.EVENT.ON_HOLD;
            }

            if (call.state == 'terminated') {
                ctiCall.status = Cti.CALL_STATUS.HANGUP;
                event = Cti.EVENT.HANGUP;
            }

            me.calls[call.id] = ctiCall;

            this._sendEvent({
                name: event,
                call: ctiCall
            });
        }
    },
    // open SIP connection
    _connect: function (sip_username, sip_password, sip_domain) {
        var me = this;
        if (!sip_username) {
            me._sendErrorEvent("Empty sip_username given");
            return;
        }

        if (!sip_password) {
            me._sendErrorEvent("Empty sip_password given");
            return;
        }

        if (!sip_domain) {
            me._sendErrorEvent("Empty sip_domain given");
            return;
        }

        me.ua = new SIP.UA({
            uri: sip_username + '@' + sip_domain,
            traceSip: false,
            log: {
                builtinEnabled: false
            },
            userAgentString: 'CTI Connector',
            wsServers: [ 'wss://' + sip_domain + ':443' ],
            authorizationUser: sip_username,
            password: sip_password,
            register: false,
            sessionDescriptionHandlerFactoryOptions:{
                peerConnectionOptions: {
                  rtcConfiguration:{
                    iceServers: []
                  }
                }
            }
        });

        me.ua.on('connecting', function(){
            me.log('SIP Connecting...');
            me.subscriptions = {};
        });
        
        me.ua.on('connected', function(){

            me.connected = true;

            me._setParam('sip_username', sip_username);
            me._setParam('sip_password', sip_password);
            me._setParam('sip_domain', sip_domain);

            // call on Connected method
            me._onConnected();
        });

        me.ua.on('disconnected', function(){
            me.log('SIP Disconnected...');
            me.subscriptions = {};
        });
    },
    _reconnect: function () {
        var me = this;
        // unable to _connect with empty storage
        if (!me._getStorage('l7_connector')) {
            me._sendErrorEvent("You need to login first in order to be able to connect to SIP server.");
            return;
        }

        me.log('re-connecting...');

        me.apiRequest('GET', '/ping', null, function() {
            me._connect(me._getParam('sip_username'), me._getParam('sip_password'), me._getParam('sip_domain'));
        }, function() {
            me._setStorage('l7_connector', {});
            if (me.keepAliveTimer) {
                clearInterval(me.keepAliveTimer);
            }
            return me._sendEvent({
                name: Cti.EVENT.LOGGED_OUT,
                message: 'User session expired.'
            });
        });
        
    },
    _hasActiveConnection: function () {
        if (this._getParam('sip_username') && this._getParam('sip_password') && this._getParam('sip_domain')) {
            return true;
        }
        return false;
    },
    _onError: function (status) {
        if (status == Strophe.Status.ERROR) {
            // do nothing
        }
    },
    _onConnected: function () {

        var me = this;

        me.log('Connected');

        me.subscribe('user:' + me._getParam('sip_username'));

        if (!me.keepAliveTimer) {
            me.keepAliveTimer = setInterval(function() {
                me.apiRequest('GET', '/ping', null, function() {
                    // do nothing
                }, function() {
                    me._setStorage('l7_connector', {});
                    return me._sendEvent({
                        name: Cti.EVENT.LOGGED_OUT,
                        message: 'User session expired.'
                    });
                });
            }, 25000);
        }

        // send Ready event
        me._sendEvent({
            name: Cti.EVENT.READY,
            message: "Connection with SIP server has been successfully established."
        });
    },
    _corsRequest: function(config) {
        var xhr = this._newXHR();

        xhr.open(config.method, this.apiEndpoint + config.url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');

        if (config.credentials) {
            xhr.setRequestHeader("Authorization", "Basic " + btoa(config.credentials.user_id + ':' + config.credentials.user_token));
        }

        xhr.onreadystatechange = function () {

            if (xhr.readyState !== 4) {
                return;
            }

            var response = '';

            if (xhr.responseText) {
                response = JSON.parse(xhr.responseText);
            }

            if (xhr.status < 400) {
                config.success(response);
            } else {
                config.failure(xhr.status, response);
            }
            
        };

        if (config.data) {
            xhr.send(JSON.stringify(config.data));
        } else {
            xhr.send();
        }
    },
    _newXHR: function () {
        var xhr = null;

        if (window.XDomainRequest) {
            this.log("using XdomainRequest for IE");

            var fireReadyStateChange = function (xhr, status) {
                xhr.status = status;
                xhr.readyState = 4;
                try {
                    xhr.onreadystatechange();
                } catch (e) {
                }
            };
            xhr = new XDomainRequest();

            xhr.readyState = 0;
            xhr.onload = function () {
                var xmlDoc = new ActiveXObject("Microsoft.XMLDOM");
                xmlDoc.async = "false";
                xmlDoc.loadXML(xhr.responseText);
                xhr.responseXML = xmlDoc;
                fireReadyStateChange(xhr, 200);
            };
            xhr.onerror = function () {
                fireReadyStateChange(xhr, 500);
            };
            xhr.ontimeout = function () {
                fireReadyStateChange(xhr, 500);
            };

        } else if (window.XMLHttpRequest) {
            this.log("using XMLHttpRequest");
            xhr = new XMLHttpRequest();
            if (xhr.overrideMimeType) {
                xhr.overrideMimeType("text/xml; charset=utf-8");
            }
        } else if (window.ActiveXObject) {
            this.log("using ActiveXObject");
            xhr = new ActiveXObject("Microsoft.XMLHTTP");
        }

        return xhr;
    },
    _nodeToArray: function (node) {
        var childNodes = node.childNodes, result = {};
        for (var i = 0; i < childNodes.length; i++) {
            node = childNodes[i];
            // IE8 hook: IE8 does not support textContent
            var text = node.textContent || node.text;
            result[node.nodeName] = text;
        }
        return result;
    },
    // strip special charactes from numsageber
    _formatE164: function (number) {
        return "+" + number.replace(/\+|-|\.|\(|\)| /g, "").replace(/^0{1,2}/g, "");
    },
    _isPhoneNumberValid: function (number) {
        return /^\+[1-9][0-9]{5,16}$/.test(number);
    },
    _isExtensionValid: function (number) {
        return /^[1-9][0-9]{3,4}$/.test(number);
    },
    _sendEvent: function (event) {
        this.callbacks.onMessage(event);
    },
    _sendInfoEvent: function (message) {
        this._sendEvent({
            name: Cti.EVENT.INFO,
            message: message
        });
    },
    _sendErrorEvent: function (message) {
        this._sendEvent({
            name: Cti.EVENT.ERROR,
            message: message
        });
    },
    _setParam: function (name, value) {
        var params = this._getParams();
        params[name] = value;
        this._setStorage('l7_connector', params);

        return this;
    },
    _getParam: function (name, defaults) {
        var params = this._getParams();
        return params[name] !== undefined ? params[name] : defaults;
    },
    _getParams: function () {
        return this._getStorage('l7_connector', {});
    },
    _getStorage: function (key, defaults) {
        var data = localStorage.getItem(key);

        if (!data) {
            return defaults;
        }

        var json = JSON.parse(data);

        if (!json) {
            return defaults;
        }

        return json;
    },
    _setStorage: function (name, value) {
        localStorage.setItem(name, JSON.stringify(value));
    },
    _removeStorage: function (name) {
        localStorage.removeItem(name);
    },
    _isSecured: function () {
        if (window.location.protocol != "https:") {
            return false;
        }
        return true;
    }
};

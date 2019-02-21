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
    if (typeof SIP == "undefined") {
        console.error('SIP dependency missing');
        return;
    }

    this.connected = false;

    this.apiEndpoint = "https://api.l7dev.co.cc/v1.1/voipstudio";
    
    // calbback
    this.callbacks = {
        onMessage: options.onMessage
    };

    if (this._hasActiveConnection()) {
        // _reconnect
        this._reconnect();
    }
};

Cti.Connector.prototype = {
    
    ua: null,
    subscriptions: {},
    calls: {},

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
        
        if (this.ua && this.ua.isConnected()) {
            this.log("Already connected");
            // mark as connected
            this.connected = true;
            // send LoggedOn event
            this._sendEvent({
                name: Cti.EVENT.LOGGED_IN,
                message: 'User is already authenticated.'
            });

            return;
        }
        
        if (arguments.length === 0 || arguments.length > 2) {
            this._sendErrorEvent("Invalid aruments number while login.");
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
                this._sendErrorEvent("Invalid API Key format, please enter <user_id:api_key>.");
                return;
            }

            userId = temp[0];
            apiKey = temp[1];
        } else {
            // authenticate via login / password
            username = arguments[0],
            password = arguments[1];
        
            if (username.length === 0 || password.length === 0) {
                this._sendErrorEvent("Missing username and/or password.");
                return;
            }
        }

        // to be used inside callbacks
        var self = this;

        var doLogin = function(credentials) {
            self._corsRequest({
                method: 'GET',
                url: '/me',
                credentials: credentials,
                success: function(response) {

                    self.log("ajax login SUCCESS");

                    self._setParam('user_id', credentials.user_id);
                    self._setParam('user_token', credentials.user_token);

                    // reset call list
                    self._setCalls({});
                    // sucessfull login
                    self.connected = true;

                    // send LoggedOn event
                    self._sendEvent({
                        name: Cti.EVENT.LOGGED_IN,
                        message: 'User has been successfully authenticated.'
                    });

                    // connext to SIP server
                    self._connect(response.data.id, response.data.sip_password, response.data.sip_domain);

                },
                failure: function() {
                    self.log("ajax login FAIL - user data failure");
                    self._sendErrorEvent("Unable to login - user data failure");
                }
            });
        };

        if (apiKey) {
            doLogin({ user_id: userId, user_token: apiKey });
        } else {
            self._corsRequest({
                method: "POST",
                url: '/login',
                data: {
                    email: username,
                    password: password
                },
                success: function(response) {
                    if (!response.user_id || !response.user_token) {
                        self._sendErrorEvent('user_id and/or user_token missing in API response.');
                        return;
                    }

                    doLogin(response);
                },
                failure: function() {
                    self.log("ajax login FAIL");
                    self._sendErrorEvent("Unable to login");
                }
            });
        }
    },
    logout: function () {
        if (!this.isConnected()) {
            this._sendErrorEvent("Connector is not connected.");
            return;
        }

        this.connected = false;

        // cleanup
        this._setStorage('l7_connector', {});

        if (this.ua.isConnected()) {
            // terminates communications with the remote service provider
            this.ua.stop();
        }

        // send LoggedOut event
        return this._sendEvent({
            name: Cti.EVENT.LOGGED_OUT,
            message: 'User has been successfully logged out.'
        });
    },
    answer: function() {
        var self = this;

        if (!this.isConnected()) {
            this._sendErrorEvent("Connector need to be connected first.");
            return;
        }

        var calls = this._getCalls();

        var callIdToAnswer = null;

        for (var id in calls) {
            var call = calls[id];

            if (call.direction == Cti.DIRECTION.IN && call.status == Cti.CALL_STATUS.RINGING) {
                callIdToAnswer = id;
            }
        }

        if (!callIdToAnswer) {
            self._sendErrorEvent("No ringing inbound calls to answer.");
            return;
        }

        self._corsRequest({
            method: 'PATCH',
            url: '/calls/' + callIdToAnswer,
            credentials: { user_id: self._getParam('user_id'), user_token: self._getParam('user_token') },
            data: {
                state: 'CONNECTED'
            },
            success: function() {
                self.log("Call Id ["+callIdToAnswer+"] answered");
            },
            failure: function(status, response) {

                var errors = [];

                if (response.message) {
                    errors.push(response.message);
                }

                if (response.errors) {
                    for (var i = 0; i < response.errors.length; i++) {
                        errors.push(response.errors[i].field + ': ' + response.errors[i].message);
                    }
                }

                var error = (errors.length > 0) ? errors.join(" ") : "Unknown API Error";

                self._sendErrorEvent(error);
            }
        });
    },
    call: function (destination) {

        if (!this.isConnected()) {
            this._sendErrorEvent("Connector need to be connected first.");
            return;
        }

        if (typeof destination === "undefined") {
            this._sendErrorEvent("Missing destination parameter");
            return;
        }

        if (destination.length === 0) {
            this._sendErrorEvent("Destination number is empty");
            return;
        }

        if (destination.length > 5) {
            // phone number
            destination = this._formatE164(destination);
            if (!this._isPhoneNumberValid(destination)) {
                this._sendErrorEvent("Phone number: " + destination + " has invalid format");
                return;
            }
        } else {
            // extension or spcial internal number
            if (this._getParam('sip_username') == destination) {
                this._sendErrorEvent("You are unable to call to yourself.");
                return;
            }
        }

        this.apiRequest('POST', '/calls', {
            to: destination.replace(/^\+/,"")
        });
    },
    terminate: function (callId) {

        if (!this.isConnected()) {
            this._sendErrorEvent("Connector need to be connected first.");
            return;
        }

        if (typeof callId === "undefined") {
            this._sendErrorEvent("Missing call ID parameter");
            return;
        }

        if (!this._hasCall(callId)) {
            this._sendErrorEvent("Call with ID: " + callId + " could not be found.");
            return;
        }

        var call = this._getCall(callId, true);

        // we can terminate calls only with status CONNECTED, ON_HOLD
        if ([Cti.CALL_STATUS.CONNECTED, Cti.CALL_STATUS.ON_HOLD].indexOf(call.status) == -1) {
            this._sendInfoEvent("Call with STATUS: " + call.status + " cannot be terminated.");
            return;
        }

        this.apiRequest('DELETE', '/calls/' + callId);
    },
    transfer: function (callId, destination) {

        if (!this.isConnected()) {
            this._sendErrorEvent("Connector need to be connected first.");
            return;
        }

        if (typeof callId === "undefined") {
            this._sendErrorEvent("Missing call ID parameter");
            return;
        }

        if (typeof destination === "undefined") {
            this._sendErrorEvent("Missing destination parameter");
            return;
        }

        if (!this._hasCall(callId)) {
            this._sendErrorEvent("Call with ID: " + callId + " could not be found.");
            return;
        }

        var call = this._getCall(callId, true);

        // we can transfer calls only with status COONNECTED
        if (call.status !== Cti.CALL_STATUS.CONNECTED) {
            this._sendInfoEvent("Call with STATUS: " + call.status + " cannot be transfered.");
            return;
        }

        if (destination.length === 0) {
            this._sendErrorEvent("Destination number is empty");
            return;
        }

        if (destination.length > 5) {
            // phone number
            destination = this._formatE164(destination);
            if (!this._isPhoneNumberValid(destination)) {
                this._sendErrorEvent("Phone number: " + destination + " has invalid format");
                return;
            }
        } else {
            // extension
            if (!this._isExtensionValid(destination)) {
                this._sendErrorEvent("Extension number: " + destination + " has invalid format");
                return;
            }

            if (this._getParam('sip_username') == destination) {
                this._sendErrorEvent("You are unable to transfer call to yourself.");
                return;
            }
        }

        // update call details
        call.destination = destination;

        this._setCall(callId, call);

        this.apiRequest('PATCH', '/calls/' + callId, {
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
    apiRequest: function(method, url, data, cb) {
        var self = this;

        var cfg = {
            method: method,
            url: url,
            credentials: { user_id: self._getParam('user_id'), user_token: self._getParam('user_token') },
            success: function() {
                if (typeof cb == 'function') {
                    cb();
                }
            },
            failure: function(status, response) {

                var errors = [];

                if (response.message) {
                    errors.push(response.message);
                }

                if (response.errors) {
                    for (var i = 0; i < response.errors.length; i++) {
                        errors.push(response.errors[i].field + ': ' + response.errors[i].message);
                    }
                }

                var error = (errors.length > 0) ? errors.join(" ") : "Unknown API Error";

                self._sendErrorEvent(error);
            }
        };

        if (data) {
            cfg.data = data;
        }

        self._corsRequest(cfg);
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


            var callId = call.id;

            me.calls[callId] = call;

            if (call.direction == "receiver") {
                if (call.state == 'confirmed') {
                    this._handleInboundCallConnected(callId, call);
                }

                if (call.state == 'early') {
                    this._handleInboundCallRinging(callId, call);
                }

                if (call.state == 'onhold') {
                    this._handleInboundCallOnHold(callId, call);
                }

                if (call.state == 'terminated') {
                    this._handleInboundCallHangUp(callId, call);
                }                
            } else {

                if (call.state == 'confirmed') {
                    this._handleOutboundCallConnected(callId, call);
                }

                if (call.state == 'early') {
                    this._handleOutboundCallRinging(callId, call);
                }

                if (call.state == 'onhold') {
                    this._handleOutboundCallOnHold(callId, call);
                }

                if (call.state == 'terminated') {
                    this._handleOutboundCallHangUp(callId, call);
                }
            }
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

        me._connect(me._getParam('sip_username'), me._getParam('sip_password'), me._getParam('sip_domain'));
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

        // send Ready event
        me._sendEvent({
            name: Cti.EVENT.READY,
            message: "Connection with SIP server has been successfully established."
        });
    },
    // Call CONNECTED
    _handleInboundCallConnected: function (callId, call_data) {
        this._handleCallConnected(callId, call_data);
    },
    _handleOutboundCallConnected: function (callId, call_data) {
        
        if (!this._hasCall(callId)) {
            // for this context calls start with CONNECTED status
            var special_contexts = ['IVR', 'TEST_CALL', 'CONF', 'VM', 'VM_MAIN', 'PICKUP_PARKED'];
            if (special_contexts.indexOf(call_data.Context) >= 0) {
                
                var call = {
                    id: callId,
                    cid: call_data.Id,
                    cause: "",
                    status: Cti.CALL_STATUS.CONNECTED,
                    direction: Cti.DIRECTION.OUT,
                    destination: call_data.Dst,
                    destinationName: call_data.DstName,
                    source: call_data.Src,
                    sourceName: call_data.SrcName
                };

                this._setCall(callId, call);
            }
        }
        
        this._handleCallConnected(callId, call_data);
    },
    _handleCallConnected: function (callId, call_data) {
        if (!this._hasCall(callId)) {
            return;
        }
        var call = this._getCall(callId);

        // update call status
        call.cid = call_data.Id;
        call.status = Cti.CALL_STATUS.CONNECTED;
        this._setCall(callId, call);

        // send CONNECTED event
        this._sendEvent({
            name: Cti.EVENT.CONNECTED,
            call: call
        });

    },
    // Call RINGING
    _handleInboundCallRinging: function (callId, call_data) {
        this.log('_handleInboundCallRinging');

        var call = {
            id: callId,
            cid: callId,
            cause: "",
            status: Cti.CALL_STATUS.RINGING,
            direction: Cti.DIRECTION.IN,
            destination: call_data.local,
            destinationName: call_data.local_name,
            source: call_data.remote,
            sourceName: call_data.remote_name
        };

        this._setCall(callId, call);

        // send Ringing event
        this._sendEvent({
            name: Cti.EVENT.RINGING,
            call: call
        });
    },
    _handleOutboundCallRinging: function (callId, call_data) {
        var call;
        if (this._hasCall(callId)) {
            // call from UI
            call = this._getCall(callId);
            // update unique call ID
            call.cid = call_data.Id;
            call.status = Cti.CALL_STATUS.RINGING;
            this._setCall(callId, call);
        } else {
            // call from Softphone
            call = {
                id: callId,
                cid: call_data.Id,
                cause: "",
                status: Cti.CALL_STATUS.RINGING,
                direction: Cti.DIRECTION.OUT,
                destination: call_data.remote,
                destinationName: call_data.remote_name,
                source: call_data.local,
                sourceName: call_data.local_name
            };

            this._setCall(callId, call);
        }

        // send RINGING event
        this._sendEvent({
            name: Cti.EVENT.RINGING,
            call: call
        });
    },
    // Call ON HOLD
    _handleInboundCallOnHold: function (callId, call_data) {
        this._handleCallOnHold(callId, call_data);
    },
    _handleOutboundCallOnHold: function (callId, call_data) {
        
        if (!this._hasCall(callId)) {
            // for this context calls start with ON_HOLD status
            if (call_data.Context == 'Queue') {
                
                var call = {
                    id: callId,
                    cid: call_data.Id,
                    cause: "",
                    status: Cti.CALL_STATUS.ON_HOLD,
                    direction: Cti.DIRECTION.OUT,
                    destination: call_data.Dst,
                    destinationName: call_data.DstName,
                    source: call_data.Src,
                    sourceName: call_data.SrcName
                };

                this._setCall(callId, call);
            }
        }
        
        this._handleCallOnHold(callId, call_data);
    },
    _handleCallOnHold: function (callId) {
        if (!this._hasCall(callId)) {
            return;
        }
        var call = this._getCall(callId);

        // update call status
        call.status = Cti.CALL_STATUS.ON_HOLD;
        this._setCall(callId, call);

        // send OnHold event
        this._sendEvent({
            name: Cti.EVENT.ON_HOLD,
            call: call
        });
    },
    // Call HANGUP
    _handleInboundCallHangUp: function (callId, call_data) {
        this._handleCallHangUp(callId, call_data);
    },
    _handleOutboundCallHangUp: function (callId, call_data) {
        this._handleCallHangUp(callId, call_data);
    },
    _handleCallHangUp: function (callId, call_data) {
        if (!this._hasCall(callId)) {
            return;
        }
        var call = this._getCall(callId);

        // update call status
        call.status = Cti.CALL_STATUS.HANGUP;
        call.cause = call_data['Cause-txt'] + " (" + call_data['Cause'] + ")";
        this._setCall(callId, call);

        // send HANGUP event
        this._sendEvent({
            name: Cti.EVENT.HANGUP,
            call: call
        });
    },
    _handleEndpointInitial: function (callId, call_data) {
        if (!this._hasCall(callId)) {
            return;
        }

        var call = this._getCall(callId),
                contact = call_data.SrcContact;

        if (call.contacts.indexOf(contact) < 0) {
            // add 
            call.contacts.push(contact);
            this._setCall(callId, call);
        }

        // if status is not set yet
        if (!call.status) {
            // update call status
            call.status = Cti.CALL_STATUS.INITIAL;
            this._setCall(callId, call);

            // send RINGING event
            this._sendEvent({
                name: Cti.EVENT.INITIAL,
                call: call
            });
        }
    },
    _handleEndpointAccepted: function (callId, call_data) {
        if (!this._hasCall(callId)) {
            return;
        }

        var call = this._getCall(callId),
                call_code = call_data.Cause,
                contact = call_data.SrcContact;

        if (Cti.CALL_CODE.ACCEPTED != call_code) {
            this._sendErrorEvent("Unexpected endpoint status: " + call_code);
            return;
        }

        // if more than one softphone is registered
        if (call.contacts.length > 1) {
            // remove all others contacts
            call.contacts = new Array(contact);
        }

        // update call status
        call.status = Cti.CALL_STATUS.ACCEPTED;
        this._setCall(callId, call);

        this._sendEvent({
            name: Cti.EVENT.ACCEPTED,
            call: call
        });
    },
    _handleEndpointNotAccepted: function (callId, call_data) {
        if (!this._hasCall(callId)) {
            return;
        }

        var call = this._getCall(callId),
                contact = call_data.SrcContact,
                index = call.contacts.indexOf(contact);

        // if contact exists
        if (index > -1) {
            // remove terminated contact
            call.contacts.splice(index, 1);
            this._setCall(callId, call);
        }

        // if there is no more softphone's reponse that we are waiting for
        if (call.contacts.length === 0) {

            // update call status
            call.status = Cti.CALL_STATUS.HANGUP;
            this._setCall(callId, call);

            // cancel call
            this._handleEndpointError(callId, "SIP Endpoint returned \"" + call_data['Cause-txt'] + "\" (" + call_data['Cause'] + ")");
        }
    },
    _handleEndpointError: function (callId, cause) {
        if (!this._hasCall(callId)) {
            return;
        }

        var call = this._getCall(callId);

        // update call status
        call.cause = cause;
        this._setCall(callId, call);

        this._fireCancelEvent(callId);
    },
    _fireCancelEvent: function (callId) {
        if (!this._hasCall(callId)) {
            return;
        }
        var call = this._getCall(callId);
        this._sendEvent({
            name: Cti.EVENT.CANCEL,
            call: call
        });

        this._removeCall(callId);
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
    },
    _getCalls: function () {
        return this._getParam('calls', {});
    },
    _setCalls: function (calls) {
        return this._setParam('calls', calls);
    },
    _hasCall: function (callId) {
        var calls = this._getCalls();
        if (!(callId in calls)) {
            return false;
        }
        return true;
    },
    _getCall: function (callId) {
        if (!this._hasCall(callId)) {
            return null;
        }
        return this._getCalls()[callId];
    },
    _setCall: function (callId, call) {
        var calls = this._getCalls();

        // old call exists ?
        if (calls.hasOwnProperty(callId)) {
            // current call
            var old_call = calls[callId];
            if (old_call.status !== call.status) {
                this.log('Call status changed to: ' + call.status);
            }
        }
        calls[callId] = call;
        this._setCalls(calls);
    },
    _removeCall: function (callId) {
        if (!this._hasCall(callId)) {
            return null;
        }

        var calls = this._getCalls();
        delete calls[callId];
        this._setCalls(calls);
    }
};

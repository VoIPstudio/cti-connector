/*
  Copyright (C) 2015 Level 7 Systems Ltd.

  This software may be modified and distributed under the terms
  of the MIT license.  See the LICENSE file for details.
*/

Cti = {
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

if (typeof Strophe != "undefined") {

    Strophe.log = function (level, msg) {
        if (level >= Strophe.LogLevel.INFO && window.console) {
            console.log('STROPHE LOG: ' + level + ' ' + msg);
        }
    };
}

Cti.Connector = function (options) {
    this.connected = false;

    this.apiLoginUrl = "https://ssl7.net/voipstudio.com/u/api/login";
    // calbback
    this.callbacks = {
        onMessage: options.onMessage
    }

    this.xhr = this._newXHR();

    if (this._hasActiveConnection()) {
        // _reconnect
        this._reconnect();
    }
}

Cti.Connector.prototype = {
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
    // draft methods
    login: function (username, password) {
        if (this._connection instanceof Strophe.Connection && this._connection.connected) {
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

        if (username.length === 0 || password.length === 0) {
            this._sendErrorEvent("Missing username and/or password.");
            return;
        }

        // to be used inside callbacks
        var self = this,
                data = {
                    api_email: username,
                    api_password: password,
                    protocol: "xmpp"
                };

        this.xhr.open("POST", this.apiLoginUrl, true);

        if ("withCredentials" in this.xhr) {
            this.xhr.withCredentials = true;
        }

        this.xhr.onreadystatechange = function () {

            if (self.xhr.readyState === 4) {
                if (self.xhr.status === 200 || self.xhr.status === 304) {
                    // done
                    var response = JSON.parse(self.xhr.responseText);

                    // Indicate a successful _connection to service provider based
                    if (response.success) {

                        self.log("ajax login SUCCESS");
                        // reset call list
                        self._setCalls({});
                        // sucessfull login
                        self.connected = true;

                        // send LoggedOn event
                        self._sendEvent({
                            name: Cti.EVENT.LOGGED_IN,
                            message: 'User has been successfully authenticated.'
                        });

                        // connext to XMPP server
                        self._connect(response.xmpp_username, response.xmpp_password, response.xmpp_domain);

                    } else {
                        self._sendErrorEvent(response.error);
                    }
                } else {
                    // fail
                    self.log("ajax login FAIL");
                    self._sendErrorEvent("Unable to login");
                }
            }
        };

        this.xhr.send(this._serialize(data));
    },
    logout: function () {
        if (!this.isConnected()) {
            this._sendErrorEvent("Connector is not connected.");
            return;
        }

        this.connected = false;

        // cleanup
        this._setCookie('l7_connector', {});

        if (this._connection.connected) {
            // terminates communications with the remote service provider
            this._connection.disconnect("logout");
        }

        // send LoggedOut event
        return this._sendEvent({
            name: Cti.EVENT.LOGGED_OUT,
            message: 'User has been successfully logged out.'
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
            if (this._getParam('xmpp_username') == destination) {
                this._sendErrorEvent("You are unable to call to yourself.");
                return;
            }
        }

        var callId = this._uniqid(),
                // call detatils
                call = {
                    id: callId,
                    cid: "",
                    cause: "",
                    status: "",
                    direction: Cti.DIRECTION.OUT,
                    destination: destination,
                    contacts: new Array()
                };

        this._setCall(callId, call);

        this.log("Call: " + destination);
        var cmd = "/call " + destination;
        var msg = $msg({
            to: 'cc@' + this._getParam('xmpp_domain'),
            type: 'chat',
            id: 'c2c' + callId
        }).c('body', {}, cmd);

        this._connection.send(msg.tree());
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

        this.log("HangUp: " + call.cid);
        var cmd = "/terminate " + call.cid;
        var msg = $msg({
            to: 'cc@' + this._getParam('xmpp_domain'),
            type: 'chat',
            id: 'c2c' + call.cid
        }).c('body', {}, cmd);

        this._connection.send(msg.tree());
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

            if (this._getParam('xmpp_username') == destination) {
                this._sendErrorEvent("You are unable to transfer call to yourself.");
                return;
            }
        }

        // update call details
        call.destination = destination;

        this._setCall(callId, call);

        // destination n
        this.log("Transfer: " + call.cid + " " + call.destination);
        var cmd = "/transfer " + call.cid + " " + call.destination;
        var msg = $msg({
            to: 'cc@' + this._getParam('xmpp_domain'),
            type: 'chat',
            id: 'c2c' + call.cid
        }).c('body', {}, cmd);

        this._connection.send(msg.tree());
    },
    // open Strophe _connection
    _connect: function (xmpp_username, xmpp_password, xmpp_domain) {
        if (!xmpp_username) {
            this._sendErrorEvent("Empty xmpp_username given");
            return;
        }

        if (!xmpp_password) {
            this._sendErrorEvent("Empty xmpp_password given");
            return;
        }

        if (!xmpp_domain) {
            this._sendErrorEvent("Empty xmpp_domain given");
            return;
        }

        var url = 'https://' + xmpp_domain + '/http-bind',
                // bare jid to be used inside callback
                bare_jid = xmpp_username + '@' + xmpp_domain,
                // to be used inside callbacks
                self = this;

        this._setParam('xmpp_domain', xmpp_domain);
        this._setParam('xmpp_username', xmpp_username);

        // open new XMPP conection with Strophe
        this._connection = new Strophe.Connection(url);
        this._connection.xmlOutput = function (elem) {
            self._setParam('rid', elem.getAttribute('rid'));
        };

        this._connection.connect(bare_jid, xmpp_password, function (status) {
            // update _connector sid
            self._setParam('sid', self._connection._proto.sid);

            // call on Connected method
            self._onConnected(status, false);
        });
    },
    _reconnect: function () {
        // unable to _connect with empty xmpp cookie
        if (!this._getCookie('l7_connector')) {
            this._sendErrorEvent("You need to login first in order to be able to connect to XMPP server.");
            return;
        }

        // _reconnect with no rid and sid
        if (!this._getParam('rid') || !this._getParam('sid')) {
            this._sendErrorEvent("You need to login first in order to be able to reconnect to XMPP server.");
            return;
        }

        var url = 'https://' + this._getParam('xmpp_domain') + '/http-bind',
                // to be used inside callbacks
                self = this;

        // open new XMPP conection with Strophe
        this._connection = new Strophe.Connection(url);
        this._connection.xmlOutput = function (elem) {
            self._setParam('rid', elem.getAttribute('rid'));
        };

        // user already connected
        this.connected = true;

        // _reconnect
        var full_jid = this._getParam('full_jid'),
                sid = this._getParam('sid'),
                rid = parseInt(this._getParam('rid')) + 1;

        this._connection.attach(full_jid, sid, rid, function (status) {
            self._onConnected(status, true);
        });
    },
    _hasActiveConnection: function () {
        if (this._getParam('rid') && this._getParam('sid') && this._getParam('xmpp_domain')) {
            return true;
        }
        return false;
    },
    _onError: function (status) {
        if (status == Strophe.Status.ERROR) {
            // do nothing
        }
    },
    _onConnected: function (status, _reconnect) {
        if (Strophe.Status.CONNECTING == status || Strophe.Status.AUTHENTICATING == status) {
            this.log('XMPP Connecting...');
        } else if (Strophe.Status.CONNECTED == status || Strophe.Status.ATTACHED == status) {
            // to be used inside callbacks
            var self = this;

            if (Strophe.Status.CONNECTED == status) {
                this.log('XMPP Connected');

                // save full jid
                this._setParam('full_jid', this._connection.jid);

                // subscribe to call events
                var iq = $iq({
                    type: 'set',
                    to: 'pubsub.' + this._getParam('xmpp_domain')
                }).c('pubsub', {
                    xmlns: 'http://jabber.org/protocol/pubsub'
                }).c('subscribe', {
                    node: 'user:' + this._getParam('xmpp_username'),
                    jid: this._connection.jid
                });
                this._connection.send(iq);

            } else {
                this.log('XMPP Re-Attached');
            }
            // Strophe handlers
            this._connection.addHandler(function (stanza) {
                self._onMessage(stanza);
                return true;
            }, null, "message");

            // send Ready event
            this._sendEvent({
                name: Cti.EVENT.READY,
                message: "Connection with XMPP server has been successfully established."
            });

        } else if (Strophe.Status.CONNFAIL == status) {
            this.log('XMPP _connection fail');
        } else if (Strophe.Status.DISCONNECTING == status) {
            this.log('XMPP disconnecting');
        } else if (Strophe.Status.DISCONNECTED == status) {
            this.log('XMPP disconnected');
            if (this.isConnected()) {
                // if xmpp data exists
                this.logout();
            }
        } else {
            this.log('Strophe unhandled status: ' + status);
        }
    },
    _onMessage: function (stanza) {
        var type = stanza.getAttribute('type');

        // error occurred
        if (Cti.TYPE.ERROR === type) {
            return true;
        }

        // HEADLINE
        if (Cti.TYPE.HEADLINE === type) {

            var items = stanza.getElementsByTagName('items');
            for (var index = 0; index < items.length; index++) {

                var item = items[index];
                if (item.getElementsByTagName('call').length > 0) {

                    var call_node = stanza.getElementsByTagName('call')[0],
                            call_data = this._nodeToArray(call_node),
                            call_status = call_data.State,
                            id = call_data.Id;

                    // ENDPOINTs
                    if (call_data.Context === "ENDPOINT") {

                        if (id.indexOf('c2c') !== 0) {
                            this.log("Invalid id: " + id);
                            return;
                        }

                        var callId = id.substring(3);
                        if (call_status === Cti.CALL_STATUS.ACCEPTED) {
                            // ACCEPTED
                            this._handleEndpointAccepted(callId, call_data);
                        } else if (call_status === Cti.CALL_STATUS.INITIAL) {
                            // INITIAL
                            this._handleEndpointInitial(callId, call_data);
                        } else {
                            // HANGUP
                            this._handleEndpointNotAccepted(callId, call_data);
                        }
                        //CALLs
                    } else {

                        var call_direction = this._getCallDirection(call_data);

                        if (call_direction === Cti.DIRECTION.IN) {

                            // skip other contexts
                            if (call_data.Context !== "LOCAL_USER") {
                                return true;
                            }

                            var callId = id;
                            if (Cti.CALL_STATUS.CONNECTED === call_status) {
                                this._handleInboundCallConnected(callId, call_data);
                            }

                            if (Cti.CALL_STATUS.RINGING === call_status) {
                                this._handleInboundCallRinging(callId, call_data);
                            }

                            if (Cti.CALL_STATUS.ON_HOLD === call_status) {
                                this._handleInboundCallOnHold(callId, call_data);
                            }

                            if (Cti.CALL_STATUS.HANGUP === call_status) {
                                this._handleInboundCallHangUp(callId, call_data);
                            }
                        }

                        if (call_direction === Cti.DIRECTION.OUT) {

                            if (typeof call_data.ReferredBy === "undefined") {
                                var callId = id;
                            } else if (call_data.ReferredBy.indexOf('c2c') !== 0) {
                                this.log("Invalid thread: " + call_data.ReferredBy);
                                return;
                            } else {
                                var callId = call_data.ReferredBy.substring(3);
                            }

                            if (Cti.CALL_STATUS.CONNECTED === call_status) {
                                this._handleOutboundCallConnected(callId, call_data);
                            }

                            if (Cti.CALL_STATUS.RINGING === call_status) {
                                this._handleOutboundCallRinging(callId, call_data);
                            }

                            if (Cti.CALL_STATUS.ON_HOLD === call_status) {
                                this._handleOutboundCallOnHold(callId, call_data);
                            }

                            if (Cti.CALL_STATUS.HANGUP === call_status) {
                                this._handleOutboundCallHangUp(callId, call_data);
                            }
                        }
                    }
                }
            }
            // CHAT
        } else if (Cti.TYPE.CHAT === type) {
            // has call id 
            if (stanza.getAttribute('id') !== undefined) {

                var id = stanza.getAttribute('id');
                if (id.indexOf('c2c') !== 0)
                    return;

                var callId = id.substring(3);
                if (stanza.getElementsByTagName('body').length > 0) {
                    var body = stanza.getElementsByTagName('body')[0],
                            // IE8 hook: IE8 does not support textContent
                            text = body.textContent || body.text;

                    if (text.indexOf("Error") > -1) {
                        this._handleEndpointError(callId, text);
                    }
                }
            }
        } else {
            this.log('Undefined type: ' + type);
        }

        return true;
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
            destination: call_data.Dst,
            destinationName: call_data.DstName,
            source: call_data.Src,
            sourceName: call_data.SrcName
        };

        this._setCall(callId, call);

        // send Ringing event
        this._sendEvent({
            name: Cti.EVENT.RINGING,
            call: call
        });
    },
    _handleOutboundCallRinging: function (callId, call_data) {
        if (this._hasCall(callId)) {
            // call from UI
            var call = this._getCall(callId);
            // update unique XMPP call ID
            call.cid = call_data.Id;
            call.status = Cti.CALL_STATUS.RINGING;
            this._setCall(callId, call);
        } else {
            // call from Softphone
            var call = {
                id: callId,
                cid: call_data.Id,
                cause: "",
                status: Cti.CALL_STATUS.RINGING,
                direction: Cti.DIRECTION.OUT,
                destination: call_data.Dst,
                destinationName: call_data.DstName,
                source: call_data.Src,
                sourceName: call_data.SrcName
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
    _handleCallOnHold: function (callId, call_data) {
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
            var xhr = new XDomainRequest();

            xhr.readyState = 0;
            xhr.onload = function () {
                xmlDoc = new ActiveXObject("Microsoft.XMLDOM");
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
            var node = childNodes[i],
                    // IE8 hook: IE8 does not support textContent
                    text = node.textContent || node.text;
            result[node.nodeName] = text;
        }
        return result;
    },
    // Call direction 
    _getCallDirection: function (call_data) {
        
        if (!call_data.SrcId) {
            return Cti.DIRECTION.IN;
        }

        if (!call_data.DstId) {
            return Cti.DIRECTION.OUT;
        }

        if (call_data.SrcId == this._getParam('xmpp_username')) {
            return Cti.DIRECTION.OUT;
        }

        return Cti.DIRECTION.IN;
    },
    // strip special charactes from numsageber
    _formatE164: function (number) {
        return "+" + number.replace(/\+|\-|\.|\(|\)| /g, "").replace(/^0{1,2}/g, "");
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
        this._setCookie('l7_connector', params);

        return this;
    },
    _getParam: function (name, defaults) {
        var params = this._getParams();
        return params[name] !== undefined ? params[name] : defaults;
    },
    _getParams: function () {
        return this._getCookie('l7_connector', {});
    },
    _getCookie: function (key, defaults) {
        var cookies = document.cookie ? document.cookie.split('; ') : [];

        for (var i = 0, l = cookies.length; i < l; i++) {
            var parts = cookies[i].split('=');
            var name = decodeURIComponent(parts.shift());
            var cookie = parts.join('=');

            if (key && key === name) {
                return JSON.parse(cookie);
            }
        }

        return defaults !== undefined ? defaults : undefined;
    },
    _setCookie: function (name, value, options) {
        var options = (options === undefined) ? {} : options;

        if (typeof options.expires === 'number') {
            var days = options.expires, t = options.expires = new Date();
            t.setTime(+t + days * 864e+5);
        }

        document.cookie = [
            // storage of JOSN objects - _serialize
            name, '=', JSON.stringify(value),
            options.expires ? '; expires=' + options.expires.toUTCString() : '', // use expires attribute, max-age is not supported by IE
            options.path ? '; path=' + options.path : '',
            options.domain ? '; domain=' + options.domain : '',
            options.secure || this._isSecured() ? '; secure' : ''
        ].join('');
    },
    _removeCookie: function (name) {
        return this._setCookie(name, '', {expires: -1});
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
    },
    _serialize: function (obj) {
        var str = [];
        for (var p in obj) {
            if (obj.hasOwnProperty(p)) {
                str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p]));
            }
        }
        return str.join("&");
    },
    // this need to be integer
    _uniqid: function () {
        return new Date().getTime();
    }
};

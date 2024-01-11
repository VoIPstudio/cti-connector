
var connector;

Cti.Platform = function () {
    // some initialization
    Cti.log("Loading connector");

    $('#status').html("Loading connector...");
    $('#status')
            .removeClass()
            .addClass('label label-warning');

    var options = {
        // callback
        onMessage: this.onMessage
    };


    connector = new Cti.Connector(options);
};

Cti.Platform.prototype = {
    username: null,
    run: function () {
        if (!connector.isConnected()) {

            document.title = "Ready";
            $('#status')
                    .html("Platform ready: Not connected.")
                    .removeClass()
                    .addClass('label label-info');
        }
    },
    login: function () {
        var username = arguments[0];
        $('#status')
            .html("Authentication " + username + "...")
            .removeClass()
            .addClass('label label-warning');

        this.username = username;

        connector.login.apply(connector, arguments);
    },
    twoFactorAuth: function() {
        connector.twoFactorAuth.apply(connector, arguments);
    },
    logout: function () {
        this.username = null;

        connector.logout();
    },
    answer: function () {
        document.title = "Answering";

        connector.answer();
    },
    call: function (destination) {
        document.title = "Connecting";

        connector.call(destination);
    },
    terminate: function (callId) {
        document.title = "Terminating";

        $('#status')
                .html("Terminating...")
                .removeClass()
                .addClass('label label-warning');

        connector.terminate(callId);
    },
    transfer: function (callId, destination) {
        document.title = "Transfering";

        $('#status')
                .html("Transfering call to " + destination + "...")
                .removeClass()
                .addClass('label label-warning');

        connector.transfer(callId, destination);
    },
    subscribe: function() {
        connector.subscribe.apply(connector, arguments);
    },
    onMessage: function (event) {
        
        Cti.log(event);

        if (event.name === Cti.EVENT.READY) {
            document.title = "Available";

            $('#status')
                    .html("Available")
                    .removeClass()
                    .addClass('label label-success');

            $('#disconnect').show();
            $('#call-outbound').prop('disabled', false);
            $('#login-form').hide();
            $('#disconnect').show();
            $('#outboundcall-form').show();
            $('#subscribe_footer').show();
        }

        if (event.name === Cti.EVENT.INITIAL) {
            $('#status')
                    .html("Softphone ringing...")
                    .removeClass()
                    .addClass('label label-warning');
        }

        if (event.name === Cti.EVENT.ACCEPTED) {
            $('#status')
                    .html("Softphone accepted...")
                    .removeClass()
                    .addClass('label label-warning');
        }

        if (event.name === Cti.EVENT.RINGING) {
            $('#disconnect').prop('disabled', true);
            $('#call-outbound').prop('disabled', true);

            // Incoming call
            if (event.call.direction === Cti.DIRECTION.IN) {

                document.title = "Incoming";
                $('#call-answer').show();
                $('#status')
                        .html("Incoming call from " + event.call.source)
                        .removeClass()
                        .addClass('label label-warning');
            } else {
                $('#status')
                        .html("Connecting to " + event.call.destination + "...")
                        .removeClass()
                        .addClass('label label-warning');
            }
        }

        if (event.name === Cti.EVENT.CONNECTED) {
            document.title = "Connected";

            $('#status')
                    .removeClass()
                    .addClass('label label-success');

            // Incoming call
            if (event.call.direction === Cti.DIRECTION.IN) {
                $('#status')
                        .html("Connected (" + event.call.sourceName + ")");
            } else {
                $('#status')
                        .html("Connected (" + event.call.destination + ")");
            }

            $('#disconnect').prop('disabled', true);
            $('#call-outbound').prop('disabled', true);
            // show buttons
            $('#toolbar-form').show();
            // hide call form
            $('#outboundcall-form').hide();
            $('#call-answer').hide();

            $('#call-terminate, #call-transfer').attr('call-id', event.call.id);
        }

        if (event.name === Cti.EVENT.ON_HOLD) {
            document.title = "OnHold";

            $('#status')
                    .html("On hold")
                    .removeClass()
                    .addClass('label label-info');

            // show buttons
            $('#toolbar-form').show();
            // hide call form
            $('#outboundcall-form').hide();
        }

        if ($.inArray(event.name, [Cti.EVENT.HANGUP, Cti.EVENT.CANCEL]) !== -1) {
            document.title = "Available";

            $('#status')
                    .html("Available")
                    .removeClass()
                    .addClass('label label-success');

            $('#disconnect').prop('disabled', false);
            $('#call-outbound').prop('disabled', false);
            // hide buttons
            $('#toolbar-form').hide();
            // show call form
            $('#outboundcall-form').show();
            $('#toolbar-form').hide();
            $('#transfer-table').hide();
            $('#call-answer').hide();

            $('#call-terminate, #call-transfer').removeAttr('call-id');

            if (event.name === Cti.EVENT.CANCEL && event.call.cause) {
                alert(event.call.cause);
            }
        }

        if ($.inArray(event.name, [Cti.EVENT.ERROR, Cti.EVENT.INFO]) !== -1) {
            document.title = "Error";

            $('#status')
                    .html("Error")
                    .removeClass()
                    .addClass('label label-danger');

            alert(event.message);
        }

        if (event.name === Cti.EVENT.TWO_FACTOR_AUTH) {
            $('#login_email_password').hide();
            $('#login_two_factor_code').show();
            $("#two_factor_auth_nonce").val(event.nonce);
        }

        if (event.name === Cti.EVENT.LOGGED_IN) {
            // add code if needed
        }

        if (event.name === Cti.EVENT.LOGGED_OUT) {
            document.title = "Ready";

            $('#status')
                    .html("Platform ready: Not connected.")
                    .removeClass()
                    .addClass('label label-info');

            $('#login-form').show();
            $('#disconnect').hide();
            $('#outboundcall-form').hide();
            $('#subscribe_footer').hide();
        }

        if (event.name === Cti.EVENT.SUBSCRIBED) {
            $('#subscriptions-list').html(connector.getSubscriptionURIs().join(" | "));
        }
    }
};


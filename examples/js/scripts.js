
$().ready(function () {

    var platform = new Cti.Platform();
    // run platform
    platform.run();
    
    $('#connect-with-username-password').click(function() {
        platform.login($('#username').val(), $('#password').val());
    });

    $('#two-factor-button').click(function() {
        platform.twoFactorAuth($('#two_factor_auth_code').val(), $('#two_factor_auth_nonce').val());
    });

    $('#subscribe-button').click(function() {
        platform.subscribe($('#subscribe-node').val());
        $('#subscribe-node').val('');
    });

    $('#connect-with-api-key').click(function() {
        platform.login($('#api_key').val());
    });
    
    $('#disconnect').click(function() {
        platform.logout();
    });
    
    $('#call-outbound').click(function() {
        platform.call($('#phone_number').val());
    });

    $('#call-answer').click(function() {
        platform.answer();
    });
    
    $('#call-terminate').click(function() {
        platform.terminate($(this).attr('call-id'));
    });
    
    $('#call-transfer').click(function() {
        $('#transfer-table').show();
    });
    
    $('#call-transfer-cancel').click(function() {
        $('#transfer-table').hide();
    });
    
    $('.call-transfer-confirm').click(function() {
        var callId = $('#call-transfer').attr('call-id'),
            destination = $(this).attr('call-extension');
        platform.transfer(callId, destination);
    });
    
    $('#call-transfer-direct-dial-confirm').click(function() {
        var callId = $('#call-transfer').attr('call-id'),
            destination = $('#call-transfer-direct-dial-phone-number').val();
        platform.transfer(callId, destination);
    });
    
});

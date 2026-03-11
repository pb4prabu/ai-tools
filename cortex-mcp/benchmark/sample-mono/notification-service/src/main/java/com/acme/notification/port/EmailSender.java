package com.acme.notification.port;

/**
 * Outbound port for sending emails.
 * Implemented by SendGrid/SES adapter.
 */
public interface EmailSender {
    /**
     * Sends an email to the specified recipient.
     * @throws EmailDeliveryException if sending fails
     */
    void send(String to, String subject, String htmlBody);

    /** Sends email with attachments. */
    void sendWithAttachment(String to, String subject, String htmlBody, byte[] attachment, String filename);
}

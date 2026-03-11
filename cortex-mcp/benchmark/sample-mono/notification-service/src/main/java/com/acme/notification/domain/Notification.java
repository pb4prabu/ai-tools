package com.acme.notification.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * Notification entity tracking all outbound communications.
 * Supports multiple channels: email, SMS, push notification.
 */
public class Notification {
    private final String id;
    private final String recipientId;
    private final String recipientEmail;
    private final NotificationType type;
    private final NotificationChannel channel;
    private final String subject;
    private final String body;
    private NotificationStatus status;
    private String failureReason;
    private int retryCount;
    private Instant createdAt;
    private Instant sentAt;

    public Notification(String recipientId, String recipientEmail,
                        NotificationType type, NotificationChannel channel,
                        String subject, String body) {
        this.id = UUID.randomUUID().toString();
        this.recipientId = recipientId;
        this.recipientEmail = recipientEmail;
        this.type = type;
        this.channel = channel;
        this.subject = subject;
        this.body = body;
        this.status = NotificationStatus.PENDING;
        this.retryCount = 0;
        this.createdAt = Instant.now();
    }

    public void markSent() {
        this.status = NotificationStatus.SENT;
        this.sentAt = Instant.now();
    }

    public void markFailed(String reason) {
        this.failureReason = reason;
        this.retryCount++;
        this.status = retryCount >= 3 ? NotificationStatus.PERMANENTLY_FAILED : NotificationStatus.FAILED;
    }

    public boolean canRetry() {
        return status == NotificationStatus.FAILED && retryCount < 3;
    }

    public String getId() { return id; }
    public String getRecipientId() { return recipientId; }
    public String getRecipientEmail() { return recipientEmail; }
    public NotificationType getType() { return type; }
    public NotificationChannel getChannel() { return channel; }
    public String getSubject() { return subject; }
    public String getBody() { return body; }
    public NotificationStatus getStatus() { return status; }
    public int getRetryCount() { return retryCount; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getSentAt() { return sentAt; }
}

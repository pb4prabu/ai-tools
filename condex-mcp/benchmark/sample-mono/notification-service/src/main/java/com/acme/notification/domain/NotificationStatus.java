package com.acme.notification.domain;

/** Notification delivery states. */
public enum NotificationStatus {
    PENDING,
    SENT,
    FAILED,
    PERMANENTLY_FAILED
}

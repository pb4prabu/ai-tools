package com.acme.notification.domain;

/** Types of notifications sent by the system. */
public enum NotificationType {
    WELCOME_EMAIL,
    ORDER_CONFIRMATION,
    PAYMENT_RECEIPT,
    SHIPPING_UPDATE,
    PASSWORD_RESET,
    ACCOUNT_DEACTIVATED,
    PROMOTIONAL
}

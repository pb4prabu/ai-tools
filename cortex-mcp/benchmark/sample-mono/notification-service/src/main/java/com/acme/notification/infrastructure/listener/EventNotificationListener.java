package com.acme.notification.infrastructure.listener;

import com.acme.notification.application.SendNotificationUseCase;
import com.acme.notification.domain.Notification;
import com.acme.notification.domain.NotificationChannel;
import com.acme.notification.domain.NotificationType;
import com.acme.shared.events.OrderCreatedEvent;
import com.acme.shared.events.PaymentCompletedEvent;
import com.acme.shared.events.UserRegisteredEvent;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Listens for domain events and sends appropriate notifications.
 * Handles welcome emails, order confirmations, and payment receipts.
 */
@Component
public class EventNotificationListener {
    private final SendNotificationUseCase sendNotification;

    public EventNotificationListener(SendNotificationUseCase sendNotification) {
        this.sendNotification = sendNotification;
    }

    @KafkaListener(topics = "UserRegisteredEvent", groupId = "notification-service")
    public void onUserRegistered(UserRegisteredEvent event) {
        Notification notification = new Notification(
            event.getAggregateId(), event.getEmail(),
            NotificationType.WELCOME_EMAIL, NotificationChannel.EMAIL,
            "Welcome to Acme Store!",
            "Hello " + event.getDisplayName() + ", welcome aboard!"
        );
        sendNotification.execute(notification);
    }

    @KafkaListener(topics = "OrderCreatedEvent", groupId = "notification-service")
    public void onOrderCreated(OrderCreatedEvent event) {
        Notification notification = new Notification(
            event.getCustomerId(), null,
            NotificationType.ORDER_CONFIRMATION, NotificationChannel.EMAIL,
            "Order Confirmed: " + event.getAggregateId(),
            "Your order of " + event.getTotalAmount() + " " + event.getCurrency() + " has been placed."
        );
        sendNotification.execute(notification);
    }

    @KafkaListener(topics = "PaymentCompletedEvent", groupId = "notification-service")
    public void onPaymentCompleted(PaymentCompletedEvent event) {
        Notification notification = new Notification(
            event.getAggregateId(), null,
            NotificationType.PAYMENT_RECEIPT, NotificationChannel.EMAIL,
            "Payment Receipt",
            "Payment of " + event.getAmount() + " via " + event.getPaymentMethod() + " completed."
        );
        sendNotification.execute(notification);
    }
}

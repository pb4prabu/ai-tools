package com.acme.payment.infrastructure.listener;

import com.acme.payment.application.ProcessPaymentUseCase;
import com.acme.shared.events.OrderCreatedEvent;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Listens for order events and triggers payment processing.
 * Auto-processes payment when a new order is created.
 */
@Component
public class OrderEventListener {
    private final ProcessPaymentUseCase processPayment;

    public OrderEventListener(ProcessPaymentUseCase processPayment) {
        this.processPayment = processPayment;
    }

    @KafkaListener(topics = "OrderCreatedEvent", groupId = "payment-service")
    public void onOrderCreated(OrderCreatedEvent event) {
        processPayment.execute(
            event.getAggregateId(),
            event.getCustomerId(),
            event.getTotalAmount(),
            event.getCurrency(),
            "default-payment-method"
        );
    }
}

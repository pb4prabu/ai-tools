package com.acme.order.port;

import com.acme.shared.events.DomainEvent;

/**
 * Outbound port for publishing domain events.
 * Implemented by Kafka/RabbitMQ adapter.
 */
public interface EventPublisher {
    void publish(DomainEvent event);
    void publishAsync(DomainEvent event);
}

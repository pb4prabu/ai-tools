package com.acme.order.infrastructure.messaging;

import com.acme.order.port.EventPublisher;
import com.acme.shared.events.DomainEvent;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

/**
 * Kafka-based implementation of EventPublisher.
 * Publishes domain events to topic derived from event class name.
 */
@Component
public class KafkaEventPublisher implements EventPublisher {
    private final KafkaTemplate<String, DomainEvent> kafkaTemplate;

    public KafkaEventPublisher(KafkaTemplate<String, DomainEvent> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    @Override
    public void publish(DomainEvent event) {
        String topic = event.getClass().getSimpleName();
        kafkaTemplate.send(topic, event.getAggregateId(), event);
    }

    @Override
    public void publishAsync(DomainEvent event) {
        String topic = event.getClass().getSimpleName();
        kafkaTemplate.send(topic, event.getAggregateId(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    // Log and potentially retry
                    System.err.println("Failed to publish event: " + ex.getMessage());
                }
            });
    }
}

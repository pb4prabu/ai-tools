package com.acme.shared.events;

import java.time.Instant;
import java.util.UUID;

/**
 * Base class for all domain events in the system.
 * Events are immutable and carry a unique identifier and timestamp.
 */
public abstract class DomainEvent {
    private final UUID eventId;
    private final Instant occurredAt;
    private final String aggregateId;

    protected DomainEvent(String aggregateId) {
        this.eventId = UUID.randomUUID();
        this.occurredAt = Instant.now();
        this.aggregateId = aggregateId;
    }

    public UUID getEventId() { return eventId; }
    public Instant getOccurredAt() { return occurredAt; }
    public String getAggregateId() { return aggregateId; }
}

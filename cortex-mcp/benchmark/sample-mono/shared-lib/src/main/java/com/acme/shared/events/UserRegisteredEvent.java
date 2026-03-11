package com.acme.shared.events;

/**
 * Published when a new user successfully registers.
 * Triggers welcome email via notification-service.
 */
public class UserRegisteredEvent extends DomainEvent {
    private final String email;
    private final String displayName;

    public UserRegisteredEvent(String userId, String email, String displayName) {
        super(userId);
        this.email = email;
        this.displayName = displayName;
    }

    public String getEmail() { return email; }
    public String getDisplayName() { return displayName; }
}

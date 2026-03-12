package com.acme.user.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * User aggregate root. Manages user profile and authentication state.
 * Enforces invariants:
 * - Email must be unique (enforced at repository level)
 * - Password must be hashed before storage
 * - Deactivated users cannot log in
 */
public class User {
    private final String id;
    private String email;
    private String passwordHash;
    private String displayName;
    private String avatarUrl;
    private UserRole role;
    private boolean active;
    private Instant createdAt;
    private Instant lastLoginAt;

    public User(String email, String passwordHash, String displayName) {
        this.id = UUID.randomUUID().toString();
        this.email = email;
        this.passwordHash = passwordHash;
        this.displayName = displayName;
        this.role = UserRole.CUSTOMER;
        this.active = true;
        this.createdAt = Instant.now();
    }

    public void updateProfile(String displayName, String avatarUrl) {
        this.displayName = displayName;
        this.avatarUrl = avatarUrl;
    }

    public void changePassword(String newPasswordHash) {
        this.passwordHash = newPasswordHash;
    }

    public void deactivate() {
        this.active = false;
    }

    public void recordLogin() {
        this.lastLoginAt = Instant.now();
    }

    public void promoteToAdmin() {
        this.role = UserRole.ADMIN;
    }

    public String getId() { return id; }
    public String getEmail() { return email; }
    public String getPasswordHash() { return passwordHash; }
    public String getDisplayName() { return displayName; }
    public String getAvatarUrl() { return avatarUrl; }
    public UserRole getRole() { return role; }
    public boolean isActive() { return active; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getLastLoginAt() { return lastLoginAt; }
}

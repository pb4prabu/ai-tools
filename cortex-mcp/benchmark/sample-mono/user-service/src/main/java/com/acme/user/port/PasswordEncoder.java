package com.acme.user.port;

/**
 * Outbound port for password hashing.
 * Implemented by BCrypt adapter.
 */
public interface PasswordEncoder {
    String encode(String rawPassword);
    boolean matches(String rawPassword, String encodedPassword);
}

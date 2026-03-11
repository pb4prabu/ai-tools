package com.acme.user.port;

import com.acme.user.domain.User;

/**
 * Outbound port for JWT token generation and validation.
 */
public interface TokenProvider {
    String generateAccessToken(User user);
    String generateRefreshToken(User user);
    String validateAndGetUserId(String token);
    boolean isTokenExpired(String token);
}

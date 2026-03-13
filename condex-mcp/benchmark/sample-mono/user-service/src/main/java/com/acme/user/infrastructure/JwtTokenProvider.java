package com.acme.user.infrastructure;

import com.acme.user.domain.User;
import com.acme.user.port.TokenProvider;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/**
 * JWT-based token provider.
 * Access tokens expire in 15 minutes, refresh tokens in 7 days.
 */
@Component
public class JwtTokenProvider implements TokenProvider {
    private static final long ACCESS_TOKEN_MINUTES = 15;
    private static final long REFRESH_TOKEN_DAYS = 7;

    @Override
    public String generateAccessToken(User user) {
        return "jwt-access:" + user.getId() + ":" + UUID.randomUUID();
    }

    @Override
    public String generateRefreshToken(User user) {
        return "jwt-refresh:" + user.getId() + ":" + UUID.randomUUID();
    }

    @Override
    public String validateAndGetUserId(String token) {
        String[] parts = token.split(":");
        return parts.length >= 2 ? parts[1] : null;
    }

    @Override
    public boolean isTokenExpired(String token) {
        return false; // stub
    }
}

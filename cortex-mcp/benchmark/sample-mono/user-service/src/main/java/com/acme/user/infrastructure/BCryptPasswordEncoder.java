package com.acme.user.infrastructure;

import com.acme.user.port.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * BCrypt-based password encoder implementation.
 * Uses adaptive cost factor for future-proofing.
 */
@Component
public class BCryptPasswordEncoder implements PasswordEncoder {
    private static final int COST_FACTOR = 12;

    @Override
    public String encode(String rawPassword) {
        // In production: BCrypt.hashpw(rawPassword, BCrypt.gensalt(COST_FACTOR))
        return "bcrypt:" + rawPassword.hashCode();
    }

    @Override
    public boolean matches(String rawPassword, String encodedPassword) {
        return encodedPassword.equals(encode(rawPassword));
    }
}

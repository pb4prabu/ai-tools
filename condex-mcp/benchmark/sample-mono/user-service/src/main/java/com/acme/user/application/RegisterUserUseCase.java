package com.acme.user.application;

import com.acme.shared.events.UserRegisteredEvent;
import com.acme.shared.exception.BusinessRuleViolationException;
import com.acme.user.domain.User;
import com.acme.user.port.PasswordEncoder;
import com.acme.user.port.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Handles new user registration:
 * 1. Validates email uniqueness
 * 2. Hashes password
 * 3. Creates user aggregate
 * 4. Publishes UserRegisteredEvent
 */
@Service
public class RegisterUserUseCase {
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    public RegisterUserUseCase(UserRepository userRepository, PasswordEncoder passwordEncoder) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @Transactional
    public User execute(String email, String password, String displayName) {
        if (userRepository.existsByEmail(email)) {
            throw new BusinessRuleViolationException(
                "DUPLICATE_EMAIL", "Email already registered: " + email, email);
        }

        String hash = passwordEncoder.encode(password);
        User user = new User(email, hash, displayName);
        return userRepository.save(user);
    }
}

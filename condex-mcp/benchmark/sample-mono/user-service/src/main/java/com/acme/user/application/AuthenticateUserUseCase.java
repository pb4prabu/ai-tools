package com.acme.user.application;

import com.acme.shared.exception.BusinessRuleViolationException;
import com.acme.user.domain.User;
import com.acme.user.port.PasswordEncoder;
import com.acme.user.port.TokenProvider;
import com.acme.user.port.UserRepository;
import org.springframework.stereotype.Service;

/**
 * Handles user authentication:
 * 1. Finds user by email
 * 2. Verifies password
 * 3. Checks account is active
 * 4. Generates JWT tokens
 * 5. Records login timestamp
 */
@Service
public class AuthenticateUserUseCase {
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final TokenProvider tokenProvider;

    public AuthenticateUserUseCase(UserRepository userRepository,
                                   PasswordEncoder passwordEncoder,
                                   TokenProvider tokenProvider) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.tokenProvider = tokenProvider;
    }

    public AuthResult execute(String email, String password) {
        User user = userRepository.findByEmail(email)
            .orElseThrow(() -> new BusinessRuleViolationException(
                "INVALID_CREDENTIALS", "Invalid email or password", email));

        if (!passwordEncoder.matches(password, user.getPasswordHash())) {
            throw new BusinessRuleViolationException(
                "INVALID_CREDENTIALS", "Invalid email or password", email);
        }

        if (!user.isActive()) {
            throw new BusinessRuleViolationException(
                "ACCOUNT_DEACTIVATED", "Account has been deactivated", user.getId());
        }

        user.recordLogin();
        userRepository.save(user);

        return new AuthResult(
            tokenProvider.generateAccessToken(user),
            tokenProvider.generateRefreshToken(user),
            user.getId(),
            user.getDisplayName()
        );
    }

    public record AuthResult(String accessToken, String refreshToken, String userId, String displayName) {}
}

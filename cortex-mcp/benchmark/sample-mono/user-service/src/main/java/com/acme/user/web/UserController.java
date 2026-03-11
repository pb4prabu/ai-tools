package com.acme.user.web;

import com.acme.shared.dto.ApiResponse;
import com.acme.user.application.AuthenticateUserUseCase;
import com.acme.user.application.RegisterUserUseCase;
import com.acme.user.domain.User;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

/**
 * REST API for user management and authentication.
 * Base path: /api/v1/users
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserController {
    private final RegisterUserUseCase registerUseCase;
    private final AuthenticateUserUseCase authUseCase;

    public UserController(RegisterUserUseCase registerUseCase,
                          AuthenticateUserUseCase authUseCase) {
        this.registerUseCase = registerUseCase;
        this.authUseCase = authUseCase;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<UserResponse> register(@Valid @RequestBody RegisterRequest request) {
        User user = registerUseCase.execute(request.email(), request.password(), request.displayName());
        return ApiResponse.ok(UserResponse.from(user));
    }

    @PostMapping("/login")
    public ApiResponse<AuthenticateUserUseCase.AuthResult> login(@Valid @RequestBody LoginRequest request) {
        return ApiResponse.ok(authUseCase.execute(request.email(), request.password()));
    }
}

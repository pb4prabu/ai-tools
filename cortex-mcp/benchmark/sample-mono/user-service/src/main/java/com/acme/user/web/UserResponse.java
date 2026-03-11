package com.acme.user.web;

import com.acme.user.domain.User;
import com.acme.user.domain.UserRole;

/** DTO for user data returned to clients. Excludes sensitive fields. */
public record UserResponse(String id, String email, String displayName, String avatarUrl, UserRole role) {
    public static UserResponse from(User user) {
        return new UserResponse(user.getId(), user.getEmail(), user.getDisplayName(), user.getAvatarUrl(), user.getRole());
    }
}

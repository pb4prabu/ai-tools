package com.acme.notification.web;

import com.acme.notification.domain.Notification;
import com.acme.notification.port.NotificationRepository;
import com.acme.shared.dto.ApiResponse;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * REST API for notification management.
 * Base path: /api/v1/notifications
 */
@RestController
@RequestMapping("/api/v1/notifications")
public class NotificationController {
    private final NotificationRepository repository;

    public NotificationController(NotificationRepository repository) {
        this.repository = repository;
    }

    @GetMapping("/user/{userId}")
    public ApiResponse<List<Notification>> getByUser(@PathVariable String userId) {
        return ApiResponse.ok(repository.findByRecipientId(userId));
    }
}

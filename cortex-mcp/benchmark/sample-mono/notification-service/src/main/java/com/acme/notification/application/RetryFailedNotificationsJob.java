package com.acme.notification.application;

import com.acme.notification.domain.Notification;
import com.acme.notification.port.NotificationRepository;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Scheduled job that retries failed notifications.
 * Runs every 5 minutes, picks up notifications with retryCount < 3.
 */
@Component
public class RetryFailedNotificationsJob {
    private final NotificationRepository repository;
    private final SendNotificationUseCase sendNotification;

    public RetryFailedNotificationsJob(NotificationRepository repository,
                                       SendNotificationUseCase sendNotification) {
        this.repository = repository;
        this.sendNotification = sendNotification;
    }

    @Scheduled(fixedRate = 300000) // 5 minutes
    public void retryFailed() {
        List<Notification> retryable = repository.findRetryable();
        for (Notification notification : retryable) {
            if (notification.canRetry()) {
                sendNotification.execute(notification);
            }
        }
    }
}

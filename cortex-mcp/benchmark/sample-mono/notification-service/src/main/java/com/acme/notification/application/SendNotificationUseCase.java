package com.acme.notification.application;

import com.acme.notification.domain.Notification;
import com.acme.notification.domain.NotificationChannel;
import com.acme.notification.port.EmailSender;
import com.acme.notification.port.NotificationRepository;
import org.springframework.stereotype.Service;

/**
 * Sends notifications through the appropriate channel.
 * Handles failures and retry tracking.
 */
@Service
public class SendNotificationUseCase {
    private final NotificationRepository notificationRepository;
    private final EmailSender emailSender;

    public SendNotificationUseCase(NotificationRepository notificationRepository, EmailSender emailSender) {
        this.notificationRepository = notificationRepository;
        this.emailSender = emailSender;
    }

    public Notification execute(Notification notification) {
        try {
            if (notification.getChannel() == NotificationChannel.EMAIL) {
                emailSender.send(notification.getRecipientEmail(),
                    notification.getSubject(), notification.getBody());
            }
            notification.markSent();
        } catch (Exception e) {
            notification.markFailed(e.getMessage());
        }
        return notificationRepository.save(notification);
    }
}

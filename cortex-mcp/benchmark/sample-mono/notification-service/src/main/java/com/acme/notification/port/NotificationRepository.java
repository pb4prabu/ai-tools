package com.acme.notification.port;

import com.acme.notification.domain.Notification;
import com.acme.notification.domain.NotificationStatus;
import java.util.List;
import java.util.Optional;

public interface NotificationRepository {
    Notification save(Notification notification);
    Optional<Notification> findById(String id);
    List<Notification> findByRecipientId(String recipientId);
    List<Notification> findByStatus(NotificationStatus status);
    List<Notification> findRetryable();
}

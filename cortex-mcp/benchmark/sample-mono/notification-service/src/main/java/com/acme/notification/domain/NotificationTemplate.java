package com.acme.notification.domain;

import java.util.Map;

/**
 * Template for generating notification content.
 * Supports variable substitution using {{variable}} syntax.
 */
public class NotificationTemplate {
    private final NotificationType type;
    private final String subjectTemplate;
    private final String bodyTemplate;

    public NotificationTemplate(NotificationType type, String subjectTemplate, String bodyTemplate) {
        this.type = type;
        this.subjectTemplate = subjectTemplate;
        this.bodyTemplate = bodyTemplate;
    }

    /**
     * Renders the template with the given variables.
     * Replaces all {{key}} placeholders with corresponding values.
     */
    public RenderedContent render(Map<String, String> variables) {
        String subject = replaceVars(subjectTemplate, variables);
        String body = replaceVars(bodyTemplate, variables);
        return new RenderedContent(subject, body);
    }

    private String replaceVars(String template, Map<String, String> variables) {
        String result = template;
        for (var entry : variables.entrySet()) {
            result = result.replace("{{" + entry.getKey() + "}}", entry.getValue());
        }
        return result;
    }

    public record RenderedContent(String subject, String body) {}
}

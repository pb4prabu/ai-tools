package com.acme.shared.exception;

/**
 * Thrown when a business rule is violated during domain operation.
 * Results in HTTP 422 response with detailed violation info.
 */
public class BusinessRuleViolationException extends RuntimeException {
    private final String ruleCode;
    private final String entityId;

    public BusinessRuleViolationException(String ruleCode, String message, String entityId) {
        super(message);
        this.ruleCode = ruleCode;
        this.entityId = entityId;
    }

    public String getRuleCode() { return ruleCode; }
    public String getEntityId() { return entityId; }
}

package com.acme.user.port;

import com.acme.user.domain.User;
import java.util.List;
import java.util.Optional;

/**
 * Outbound port for user persistence.
 */
public interface UserRepository {
    User save(User user);
    Optional<User> findById(String id);
    Optional<User> findByEmail(String email);
    List<User> findAll(int offset, int limit);
    boolean existsByEmail(String email);
    void deleteById(String id);
}

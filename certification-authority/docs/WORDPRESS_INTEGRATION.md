# WordPress Integration Guide - Secure Information Portal

**Phase 2 Implementation** - Progressive Disclosure Content Management

This document provides complete instructions for integrating WordPress as the content management system for the Secure Information Portal while maintaining the existing progressive disclosure functionality.

---

## Overview

**Current (Phase 1)**: Content stored in `/lib/contentDatabase.js` as local JSON
**Future (Phase 2)**: Content managed via WordPress with custom fields and REST API

**Architecture**: API-First Headless WordPress
- WordPress = Content management backend
- CA Server = Presentation layer (no changes to dashboard.html)
- Database abstraction layer enables seamless switching

---

## Prerequisites

- WordPress 6.0+ installation
- Advanced Custom Fields (ACF) Pro plugin
- Basic understanding of WordPress REST API
- Node.js environment for CA Server

---

## Phase 2 Migration Steps

### Step 1: WordPress Setup

#### 1.1 Install WordPress

```bash
# Standard WordPress installation
# Can be on same server or separate server

# Example for separate WordPress instance
cd /var/www/html
wget https://wordpress.org/latest.tar.gz
tar -xzf latest.tar.gz
# Complete standard WordPress setup
```

#### 1.2 Install Required Plugins

**Required**:
- Advanced Custom Fields (ACF) Pro - Custom field management
- WP REST API Controller - API access control

**Optional but Recommended**:
- Yoast SEO - Content organization
- Revision Manager - Content versioning

### Step 2: Custom Post Type Setup

Create custom post type for security clearance content:

**File**: `wp-content/themes/[your-theme]/functions.php`

```php
<?php
/**
 * Register Security Clearance Content Post Type
 */
function register_clearance_content_post_type() {
    $labels = array(
        'name'               => 'Security Content',
        'singular_name'      => 'Security Content',
        'menu_name'          => 'Security Content',
        'add_new'            => 'Add New',
        'add_new_item'       => 'Add New Content',
        'edit_item'          => 'Edit Content',
        'new_item'           => 'New Content',
        'view_item'          => 'View Content',
        'search_items'       => 'Search Content',
        'not_found'          => 'No content found',
        'not_found_in_trash' => 'No content found in Trash',
    );

    $args = array(
        'labels'              => $labels,
        'public'              => true,
        'publicly_queryable'  => true,
        'show_ui'             => true,
        'show_in_menu'        => true,
        'query_var'           => true,
        'rewrite'             => array('slug' => 'security-content'),
        'capability_type'     => 'post',
        'has_archive'         => true,
        'hierarchical'        => false,
        'menu_position'       => 5,
        'menu_icon'           => 'dashicons-lock',
        'show_in_rest'        => true, // Enable REST API
        'rest_base'           => 'security-content',
        'supports'            => array('title', 'editor', 'custom-fields'),
    );

    register_post_type('security_content', $args);
}
add_action('init', 'register_clearance_content_post_type');
```

### Step 3: Advanced Custom Fields Configuration

**Field Group Name**: "Security Clearance Metadata"
**Location Rule**: Post Type is equal to Security Content

#### ACF Field Definitions (JSON)

```json
{
  "key": "group_clearance_metadata",
  "title": "Security Clearance Metadata",
  "fields": [
    {
      "key": "field_clearance_level",
      "label": "Required Clearance Level",
      "name": "clearance_level",
      "type": "select",
      "instructions": "Minimum clearance level required to view this content",
      "required": 1,
      "choices": {
        "0": "PUBLIC",
        "1": "INTERNAL",
        "2": "CONFIDENTIAL",
        "3": "RESTRICTED",
        "4": "TOP-SECRET"
      },
      "default_value": "0"
    },
    {
      "key": "field_clearance_badge",
      "label": "Clearance Badge",
      "name": "clearance_badge",
      "type": "text",
      "instructions": "Badge text (e.g., 'INTERNAL', 'CONFIDENTIAL')",
      "required": 1
    },
    {
      "key": "field_category",
      "label": "Category",
      "name": "category",
      "type": "select",
      "instructions": "Content category for organization",
      "choices": {
        "general": "General",
        "operations": "Operations",
        "hr": "Human Resources",
        "projects": "Projects",
        "security": "Security",
        "business": "Business",
        "strategic": "Strategic"
      },
      "default_value": "general"
    },
    {
      "key": "field_sort_order",
      "label": "Sort Order",
      "name": "sort_order",
      "type": "number",
      "instructions": "Display order (lower numbers appear first)",
      "default_value": 100
    }
  ],
  "location": [
    [
      {
        "param": "post_type",
        "operator": "==",
        "value": "security_content"
      }
    ]
  ]
}
```

**To Import ACF Fields**:
1. WordPress Admin → Custom Fields → Tools → Import Field Groups
2. Paste JSON above
3. Click "Import File"

### Step 4: WordPress REST API Endpoint

**File**: `wp-content/themes/[your-theme]/functions.php` or custom plugin

```php
<?php
/**
 * Custom REST API Endpoint for Secure Content
 */
function register_security_content_api() {
    register_rest_route('security/v1', '/content', array(
        'methods'  => 'GET',
        'callback' => 'get_security_content',
        'permission_callback' => '__return_true', // Public endpoint
        'args' => array(
            'clearance_level' => array(
                'required' => false,
                'type' => 'integer',
                'description' => 'User clearance level (0-4)',
                'validate_callback' => function($param) {
                    return is_numeric($param) && $param >= 0 && $param <= 4;
                }
            ),
        ),
    ));
}
add_action('rest_api_init', 'register_security_content_api');

/**
 * Get security content based on clearance level
 */
function get_security_content($request) {
    $clearance_level = isset($request['clearance_level'])
        ? intval($request['clearance_level'])
        : 0; // Default to PUBLIC

    // Query posts accessible at this clearance level
    $args = array(
        'post_type'      => 'security_content',
        'post_status'    => 'publish',
        'posts_per_page' => -1,
        'orderby'        => 'meta_value_num',
        'meta_key'       => 'sort_order',
        'order'          => 'ASC',
        'meta_query'     => array(
            array(
                'key'     => 'clearance_level',
                'value'   => $clearance_level,
                'compare' => '<=',
                'type'    => 'NUMERIC'
            )
        )
    );

    $query = new WP_Query($args);
    $sections = array();

    if ($query->have_posts()) {
        while ($query->have_posts()) {
            $query->the_post();
            $post_id = get_the_ID();

            // Get ACF fields
            $required_level = get_field('clearance_level', $post_id);
            $clearance_badge = get_field('clearance_badge', $post_id);
            $category = get_field('category', $post_id);

            $sections[] = array(
                'id'              => 'wp-' . $post_id,
                'title'           => get_the_title(),
                'content'         => get_the_content(),
                'requiredLevel'   => intval($required_level),
                'clearanceBadge'  => $clearance_badge,
                'category'        => $category,
            );
        }
        wp_reset_postdata();
    }

    return new WP_REST_Response($sections, 200);
}

/**
 * Add CORS headers for external API access
 */
function add_cors_headers() {
    // Replace with your CA Server domain
    $allowed_origin = 'http://91.99.4.54:3005';

    header("Access-Control-Allow-Origin: $allowed_origin");
    header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
    header("Access-Control-Allow-Headers: Content-Type");
}
add_action('rest_api_init', function() {
    add_filter('rest_pre_serve_request', function() {
        add_cors_headers();
        return false;
    });
});
```

### Step 5: CA Server Configuration

Update environment variables to enable WordPress mode:

**File**: `/root/certification-authority/.env` (create if doesn't exist)

```bash
# Content Source Configuration
CONTENT_SOURCE=wordpress
WORDPRESS_URL=https://your-wordpress-site.com
WORDPRESS_API_ENDPOINT=/wp-json/security/v1/content
```

**Restart CA Server**:
```bash
pkill -f "PORT=3005"
cd /root/certification-authority
PORT=3005 node server.js > ca.log 2>&1 &
```

### Step 6: Content Migration

**File**: `contentDatabase.js` already handles WordPress (lines 344-349)

```javascript
async getContentFromWordPress(clearanceLevel) {
  try {
    const levelParam = clearanceLevel ?
      (CLEARANCE_HIERARCHY[clearanceLevel] || 0) : 0;

    const apiUrl = `${this.wordPressURL}${process.env.WORDPRESS_API_ENDPOINT || '/wp-json/security/v1/content'}`;
    const response = await fetch(`${apiUrl}?clearance_level=${levelParam}`);

    if (!response.ok) {
      throw new Error(`WordPress API returned ${response.status}`);
    }

    const sections = await response.json();

    console.log(`[ContentDatabase] WordPress: Returning ${sections.length} sections for level ${clearanceLevel || 'PUBLIC'}`);

    return sections;
  } catch (error) {
    console.error('[ContentDatabase] WordPress fetch error:', error);
    // Fallback to local content on error
    return this.getContentFromLocal(clearanceLevel);
  }
}
```

**Migration Script** (optional - to bulk import existing content):

```javascript
// migration-script.js
const fetch = require('node-fetch');

const WP_URL = 'https://your-wordpress-site.com';
const WP_USER = 'admin';
const WP_APP_PASSWORD = 'xxxx xxxx xxxx xxxx';

const LOCAL_CONTENT = require('./lib/contentDatabase').LOCAL_CONTENT;

async function migrateContent() {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  for (const section of LOCAL_CONTENT.sections) {
    const postData = {
      title: section.title,
      content: section.content,
      status: 'publish',
      fields: {
        clearance_level: section.requiredLevel,
        clearance_badge: section.clearanceBadge,
        category: section.category,
        sort_order: section.requiredLevel * 100
      }
    };

    const response = await fetch(`${WP_URL}/wp-json/wp/v2/security_content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      body: JSON.stringify(postData)
    });

    if (response.ok) {
      console.log(`✅ Migrated: ${section.title}`);
    } else {
      console.error(`❌ Failed: ${section.title}`);
    }
  }
}

migrateContent();
```

---

## WordPress Admin Guide

### Adding New Security Content

1. **WordPress Admin** → Security Content → Add New

2. **Fill in fields**:
   - **Title**: Section heading (e.g., "Q1 2026 Financial Report")
   - **Content**: Full content body (supports markdown-style formatting)
   - **Required Clearance Level**: Minimum level to view (PUBLIC to TOP-SECRET)
   - **Clearance Badge**: Badge text displayed on card
   - **Category**: Organizational category
   - **Sort Order**: Display order (lower = higher priority)

3. **Publish**: Content immediately available via REST API

### Content Organization Best Practices

**Sort Order Guidelines**:
- PUBLIC: 1-99
- INTERNAL: 100-199
- CONFIDENTIAL: 200-299
- RESTRICTED: 300-399
- TOP-SECRET: 400-499

**Category Usage**:
- `general`: Welcome messages, announcements
- `operations`: Business operations, financial reports
- `hr`: Human resources, policies
- `projects`: Project updates, development status
- `security`: Security incidents, audits
- `business`: Client acquisition, partnerships
- `strategic`: Executive-level intelligence

### Content Versioning

WordPress automatically saves revisions. To restore previous version:
1. Edit post → Revisions (right sidebar)
2. Browse previous versions
3. Click "Restore This Revision"

---

## Testing WordPress Integration

### Test 1: Verify REST API

```bash
# Test PUBLIC content (no authentication)
curl "https://your-wordpress-site.com/wp-json/security/v1/content?clearance_level=0" | jq

# Expected: Array of public content sections

# Test CONFIDENTIAL content
curl "https://your-wordpress-site.com/wp-json/security/v1/content?clearance_level=2" | jq

# Expected: Array including public + internal + confidential sections
```

### Test 2: Verify CA Integration

```bash
# Set environment variables
export CONTENT_SOURCE=wordpress
export WORDPRESS_URL=https://your-wordpress-site.com

# Restart CA server
cd /root/certification-authority
PORT=3005 node server.js

# Check logs
tail -f ca.log | grep ContentDatabase

# Expected output:
# [ContentDatabase] Initialized with source: wordpress
# [ContentDatabase] WordPress: Returning 5 sections for level CONFIDENTIAL
```

### Test 3: End-to-End Dashboard Test

1. **Unauthenticated Access**:
   - Visit: `http://91.99.4.54:3005/dashboard`
   - Should see: Public content only, "Get Security Clearance" button

2. **Authenticated Access**:
   - Complete VC verification flow
   - Dashboard automatically loads with session parameter
   - Should see: Expanded content based on clearance level

---

## Troubleshooting

### Issue: CORS Errors

**Symptom**: Browser console shows CORS policy errors

**Solution**: Verify CORS headers in WordPress functions.php:
```php
// Update allowed origin to match your CA Server
$allowed_origin = 'http://91.99.4.54:3005';
```

### Issue: Empty Content Returned

**Symptom**: Dashboard shows "No content available"

**Solution 1**: Check WordPress posts are published (not drafts)
**Solution 2**: Verify ACF fields are filled correctly
**Solution 3**: Check WordPress REST API directly:
```bash
curl "https://your-wordpress-site.com/wp-json/security/v1/content?clearance_level=0"
```

### Issue: Fallback to Local Content

**Symptom**: Logs show "falling back to local"

**Solution**: Check environment variables:
```bash
echo $CONTENT_SOURCE  # Should be 'wordpress'
echo $WORDPRESS_URL   # Should be full WordPress URL
```

### Issue: Authentication Errors

**Symptom**: 401 Unauthorized from WordPress API

**Solution**: Public endpoint doesn't require auth. If getting 401:
1. Check `permission_callback => '__return_true'` in REST route
2. Verify endpoint is `/security/v1/content` not `/wp/v2/...`

---

## Performance Optimization

### Caching Strategy

Add WordPress object caching for high-traffic scenarios:

```php
function get_security_content($request) {
    $clearance_level = isset($request['clearance_level'])
        ? intval($request['clearance_level'])
        : 0;

    // Check cache first (15-minute TTL)
    $cache_key = "security_content_level_{$clearance_level}";
    $cached = wp_cache_get($cache_key);

    if ($cached !== false) {
        return new WP_REST_Response($cached, 200);
    }

    // ... existing query code ...

    // Store in cache
    wp_cache_set($cache_key, $sections, '', 900); // 15 minutes

    return new WP_REST_Response($sections, 200);
}
```

### CDN Integration

For WordPress hosted separately, use CDN for REST API:
- CloudFlare: Enable API caching with 15-minute TTL
- AWS CloudFront: Cache `/wp-json/security/v1/content*` paths

---

## Security Considerations

### WordPress Hardening

**Required**:
1. Use strong admin passwords
2. Enable 2FA for WordPress admin accounts
3. Keep WordPress core + plugins updated
4. Limit REST API exposure (ACF permissions)

**File**: `wp-content/themes/[your-theme]/functions.php`

```php
// Disable unused REST API endpoints
add_filter('rest_endpoints', function($endpoints) {
    // Only allow security content endpoint
    $allowed = array('/security/v1/content');

    foreach ($endpoints as $route => $endpoint) {
        if (!in_array($route, $allowed)) {
            unset($endpoints[$route]);
        }
    }

    return $endpoints;
});

// Add rate limiting (requires Redis)
function rate_limit_security_api($result) {
    $ip = $_SERVER['REMOTE_ADDR'];
    $key = "api_rate_limit_{$ip}";

    $requests = wp_cache_get($key);
    if ($requests === false) {
        wp_cache_set($key, 1, '', 60); // 1 request, 60 sec TTL
    } elseif ($requests > 60) {
        return new WP_Error('rate_limit_exceeded', 'Too many requests', array('status' => 429));
    } else {
        wp_cache_incr($key);
    }

    return $result;
}
add_filter('rest_pre_dispatch', 'rate_limit_security_api', 10, 3);
```

---

## Rollback Plan

To rollback to Phase 1 local content:

```bash
# Update environment
export CONTENT_SOURCE=local
# OR remove CONTENT_SOURCE variable entirely

# Restart CA Server
pkill -f "PORT=3005"
cd /root/certification-authority
PORT=3005 node server.js > ca.log 2>&1 &

# Verify
curl http://91.99.4.54:3005/api/dashboard/content | jq '.sections | length'
# Should return content from contentDatabase.js
```

---

## Future Enhancements

### WordPress Multisite

For multiple organizations:
- Each site = separate security clearance system
- Shared theme/plugin code
- Isolated content databases

### Content Encryption (Phase 3)

After Phase 2 WordPress integration, add BroadcastChannel encryption:
- WordPress stores encrypted content
- Public keys in ACF fields
- Decryption handled client-side

### GraphQL API

Alternative to REST for complex queries:
- WPGraphQL plugin
- Custom field resolvers
- Reduced API calls

---

## Support Resources

**WordPress REST API**: https://developer.wordpress.org/rest-api/
**ACF Documentation**: https://www.advancedcustomfields.com/resources/
**Custom Post Types**: https://developer.wordpress.org/plugins/post-types/

---

**Document Version**: 1.0
**Last Updated**: October 30, 2025
**Compatibility**: WordPress 6.0+, ACF Pro 6.0+, Node.js 16+

# Fixing Notion API 403 Errors in Production

This document outlines the fixes applied to resolve 403 Forbidden errors when building for production on Vercel.

## Root Cause
The 403 errors were occurring due to:
1. **Authentication Issues**: Notion token authentication failing in production environment
2. **Rate Limiting**: Too many concurrent requests to Notion API during build
3. **Missing Error Handling**: Build process failing completely when individual pages couldn't be accessed

## Applied Fixes

### 1. Enhanced Error Handling in Notion API Client
- Added retry logic with exponential backoff for 403, 429, and 5xx errors
- Added timeout configuration (30 seconds)
- Improved error logging with specific status codes and messages
- Added specific handling for 403 Forbidden errors with clearer messaging

### 2. Reduced Concurrency to Prevent Rate Limiting
- Reduced default concurrency from 3 to 1 in `NotionAPI.getPage()`
- Reduced navigation page fetching concurrency from 4 to 1
- Added 100ms delays between page requests in site map generation

### 3. Graceful Error Handling in Page Resolution
- Added try-catch blocks around all `getPage()` calls
- Return appropriate error objects instead of throwing on 403 errors
- Added fallback mechanisms for both individual pages and root pages

### 4. Improved Static Generation
- Enhanced `getStaticPaths()` with error handling to prevent build failures
- Modified `getStaticProps()` to return `notFound: true` for 403 errors instead of failing the build
- Added fallback mechanisms for missing or inaccessible pages

### 5. Environment Variable Validation
- Created environment validation function to check required variables at startup
- Added validation for token format
- Enhanced error messages for missing configuration

### 6. Production Configuration
- Added `vercel.json` with proper environment variable mapping
- Extended function timeout to 30 seconds for API calls
- Fixed type compatibility issues between different notion-types versions

## Required Vercel Environment Variables

Ensure these environment variables are set in your Vercel project settings:

```
NOTION_TOKEN_V2=<your-notion-token>
NOTION_ACTIVE_USER=<your-notion-user-id>
NOTION_API_BASE_URL=https://kalenwallin.notion.site/api/v3
REDIS_URL=<your-redis-url>
UPSTASH_REDIS_REST_TOKEN=<your-upstash-token>
UPSTASH_REDIS_REST_URL=<your-upstash-url>
```

## Deployment Steps

1. **Verify Environment Variables**: Ensure all required environment variables are set in Vercel dashboard
2. **Check Token Validity**: Make sure your `NOTION_TOKEN_V2` is still valid and has access to all required pages
3. **Verify Page Permissions**: Ensure your Notion workspace and pages are accessible with the provided token
4. **Deploy**: The build should now be more resilient to temporary API issues

## Monitoring

- Check Vercel function logs for any remaining 403 errors
- Monitor build times - they may be longer due to reduced concurrency but should be more reliable
- Watch for pages returning 404 instead of 403 - these will be handled gracefully without breaking the build

## Fallback Behavior

- Pages that return 403 errors will show as "not found" instead of breaking the entire build
- The site will use ISR (Incremental Static Regeneration) to retry failed pages
- Root page access issues will return a proper error page instead of crashing

This approach ensures your site can build successfully even if some Notion pages are temporarily inaccessible, while still maintaining functionality for accessible content.
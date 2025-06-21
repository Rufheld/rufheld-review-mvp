// server.js - Rufheld Review API Backend
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve frontend files

// Environment variables validation
const requiredEnvVars = ['WEXTRACTOR_API_KEY'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`Missing required environment variable: ${envVar}`);
        process.exit(1);
    }
}

// In-memory cache for demo (use Redis in production)
const reviewsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper function to get cached reviews
function getCachedReviews(placeId) {
    const cached = reviewsCache.get(placeId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    return null;
}

// Helper function to cache reviews
function cacheReviews(placeId, data) {
    reviewsCache.set(placeId, {
        data,
        timestamp: Date.now()
    });
}

// Route: Fetch reviews for a place
app.get('/api/reviews/:placeId', async (req, res) => {
    try {
        const { placeId } = req.params;
        const offset = parseInt(req.query.offset) || 0;
        const sort = req.query.sort || 'lowest_rating';

        console.log(`Fetching reviews for place: ${placeId}, offset: ${offset}`);

        // Check cache first
        const cacheKey = `${placeId}_${offset}_${sort}`;
        const cachedData = getCachedReviews(cacheKey);
        if (cachedData) {
            console.log('Returning cached data');
            return res.json(cachedData);
        }

        // Call Wextractor API
        const wextractorUrl = 'https://wextractor.com/api/v1/reviews/google';
        const params = {
            id: placeId,
            auth_token: process.env.WEXTRACTOR_API_KEY,
            offset: offset,
            sort: sort,
            language: 'de'
        };

        const response = await axios.get(wextractorUrl, { params });
        const data = response.data;

        // Process the response
        const processedReviews = data.reviews.map(review => ({
            id: review.id,
            rating: review.rating,
            text: review.text || '',
            reviewer: review.reviewer || 'Anonymer Nutzer',
            datetime: review.datetime,
            reviewer_id: review.reviewer_id,
            url: review.url,
            likes: review.likes || 0
        }));

        // Determine if there are more reviews
        const hasMore = processedReviews.length === 10; // Wextractor returns 10 per page

        const result = {
            success: true,
            reviews: processedReviews,
            hasMore: hasMore,
            totalReviews: data.totals?.review_count || 0,
            averageRating: data.totals?.average_rating || 0,
            placeDetails: data.place_details || {},
            offset: offset
        };

        // Cache the result
        cacheReviews(cacheKey, result);

        res.json(result);

    } catch (error) {
        console.error('Error fetching reviews:', error.response?.data || error.message);
        
        // Return appropriate error message
        let errorMessage = 'Fehler beim Laden der Bewertungen.';
        if (error.response?.status === 401) {
            errorMessage = 'API-Authentifizierung fehlgeschlagen.';
        } else if (error.response?.status === 403) {
            errorMessage = 'API-Limit erreicht. Bitte versuchen Sie es später erneut.';
        } else if (error.response?.status === 429) {
            errorMessage = 'Zu viele Anfragen. Bitte warten Sie einen Moment.';
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Route: Submit selected reviews for processing
app.post('/api/submit-order', async (req, res) => {
    try {
        const { placeId, selectedReviews, businessInfo } = req.body;

        // Validation
        if (!placeId || !selectedReviews || selectedReviews.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Ungültige Anfrage. PlaceID und ausgewählte Bewertungen sind erforderlich.'
            });
        }

        // Calculate total price
        const totalPrice = selectedReviews.length * 39.99;

        // Here you would typically:
        // 1. Save to database
        // 2. Send to Zoho CRM via API
        // 3. Send confirmation email
        // 4. Create internal ticket

        console.log('Order submitted:', {
            placeId,
            selectedReviews: selectedReviews.length,
            totalPrice,
            businessInfo
        });

        // For MVP, just log and return success
        res.json({
            success: true,
            message: 'Anfrage erfolgreich eingereicht.',
            orderId: `RH-${Date.now()}`, // Simple order ID for demo
            totalPrice: totalPrice,
            reviewCount: selectedReviews.length,
            estimatedProcessingTime: '24-48 Stunden'
        });

    } catch (error) {
        console.error('Error submitting order:', error);
        res.status(500).json({
            success: false,
            error: 'Fehler beim Verarbeiten der Anfrage.'
        });
    }
});

// Route: Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Route: Get business details (optional, for additional info)
app.get('/api/business/:placeId', async (req, res) => {
    try {
        const { placeId } = req.params;

        // This would call Google Places API for detailed business info
        // For now, return placeholder
        res.json({
            success: true,
            business: {
                placeId: placeId,
                name: 'Business Name',
                address: 'Business Address',
                // Add more details as needed
            }
        });

    } catch (error) {
        console.error('Error fetching business details:', error);
        res.status(500).json({
            success: false,
            error: 'Fehler beim Laden der Unternehmensdaten.'
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Ein unerwarteter Fehler ist aufgetreten.'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint nicht gefunden.'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Rufheld API Server läuft auf Port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Wextractor API configured: ${!!process.env.WEXTRACTOR_API_KEY}`);
});

module.exports = app;
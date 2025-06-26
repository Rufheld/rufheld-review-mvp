// server.js - Rufheld Review API Backend
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
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

// Database connection
let pool = null;
if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    console.log('✅ Database connection configured');
} else {
    console.log('⚠️  No DATABASE_URL found - database features disabled');
}

// Email transporter setup - Zoho Mail optimiert
let emailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    emailTransporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtppro.zoho.eu',
        port: parseInt(process.env.EMAIL_PORT) || 465,
        secure: process.env.EMAIL_SECURE === 'true' || process.env.EMAIL_PORT === '465',
        auth: {
            user: process.env.EMAIL_USER, // info@rufheld.de
            pass: process.env.EMAIL_PASS  // dein zoho passwort
        },
        // Zoho-spezifische Optimierungen:
        pool: true,              // Verbindungen wiederverwenden
        maxConnections: 5,       // Max gleichzeitige Verbindungen
        maxMessages: 100,        // Max Nachrichten pro Verbindung
        rateDelta: 1000,         // Rate limiting
        rateLimit: 10,           // Max 10 emails per second
        tls: {
            rejectUnauthorized: false
        }
    });
    
    // Verbindung testen
    emailTransporter.verify((error, success) => {
        if (error) {
            console.error('❌ Zoho Mail connection failed:', error);
        } else {
            console.log('✅ Zoho Mail server is ready to take messages');
        }
    });
    
    console.log('✅ Zoho Mail transporter configured for Rufheld');
} else {
    console.log('⚠️  Email credentials not found - email features disabled');
}

// Create orders table on startup
async function initDatabase() {
    if (!pool) {
        console.log('⚠️  Skipping database initialization - no database connection');
        return;
    }
    
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                order_id VARCHAR(50) UNIQUE NOT NULL,
                business_name TEXT NOT NULL,
                business_place_id TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                customer_email TEXT NOT NULL,
                customer_phone TEXT NOT NULL,
                selected_reviews JSONB NOT NULL,
                total_price DECIMAL(10,2) NOT NULL,
                review_count INTEGER NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Database table initialized');
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
    }
}

// Initialize database when server starts
initDatabase();

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

// Email-Test Route für Debugging
app.get('/api/test-email', async (req, res) => {
    if (!emailTransporter) {
        return res.json({ success: false, error: 'Email not configured' });
    }
    
    try {
        await emailTransporter.sendMail({
            from: '"Rufheld" <info@rufheld.de>',
            to: 'business@rufheld.de', // An dich selbst
            subject: 'Zoho Mail Test - Railway Backend',
            html: `
                <h2>🧪 Zoho Mail Test erfolgreich!</h2>
                <p>Dein Railway Backend kann erfolgreich Emails über Zoho Mail versenden.</p>
                <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
                <p><strong>Server:</strong> Railway</p>
                <p><strong>Email Service:</strong> Zoho Mail (smtppro.zoho.eu)</p>
            `
        });
        
        res.json({ 
            success: true, 
            message: 'Test email sent successfully!',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Test email failed:', error);
        res.json({ 
            success: false, 
            error: error.message,
            details: error
        });
    }
});

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

// Route: Submit selected reviews for processing - VOLLSTÄNDIG KORRIGIERTE VERSION
app.post('/api/submit-order', async (req, res) => {
    try {
        const { 
            businessPlaceId, 
            selectedReviews, 
            businessName,
            customerName,
            customerEmail,
            customerPhone,
            totalPrice 
        } = req.body;

        // Validation
        if (!businessPlaceId || !selectedReviews || selectedReviews.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Ungültige Anfrage. PlaceID und ausgewählte Bewertungen sind erforderlich.'
            });
        }

        // Generate order ID
        const orderId = `RH-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const calculatedPrice = selectedReviews.length * 39.99;

        console.log('Order submitted:', {
            orderId,
            businessPlaceId,
            businessName,
            customerName,
            customerEmail,
            customerPhone,
            selectedReviews: selectedReviews.length,
            totalPrice: calculatedPrice
        });

        // Save to database (if available)
        if (pool) {
            try {
                const query = `
                    INSERT INTO orders (
                        order_id, business_name, business_place_id, 
                        customer_name, customer_email, customer_phone,
                        selected_reviews, total_price, review_count
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING *
                `;
                
                const values = [
                    orderId, businessName, businessPlaceId,
                    customerName, customerEmail, customerPhone,
                    JSON.stringify(selectedReviews), calculatedPrice, selectedReviews.length
                ];

                await pool.query(query, values);
                console.log('✅ Order saved to database:', orderId);
            } catch (dbError) {
                console.error('❌ Database save failed:', dbError);
                // Continue anyway - don't fail the request
            }
        }

        // Send emails (if configured)
        if (emailTransporter) {
            try {
                // Customer confirmation email HTML (deine angepasste Version)
                const customerEmailHtml = `
                    <!-- Logo-Bereich mit weißem Hintergrund -->
                    <div style="background: white; padding: 30px 20px; text-align: center; border-bottom: 1px solid #e9ecef;">
                        <img src="https://cdn.prod.website-files.com/66e9bed574500384950cc91e/682448c7f93ce636595a9424_66eac46dad1e9ecc1d56792b_55918_RufHeld_RB-03-FINAL-p-1080.png.png" 
                             alt="Rufheld Logo" 
                             style="max-width: 200px; height: auto;">
                    </div>
                    
                    <!-- Header-Bereich mit Gradient (ohne Logo) -->
                    <div style="background: linear-gradient(135deg, #00277C 0%, #1DC3A3 100%); color: white; padding: 30px 20px; text-align: center;">
                        <h2 style="margin: 0 0 10px 0; font-size: 24px;">🏆 Ihr Auftrag wurde eingereicht!</h2>
                    </div>
                        
                        <div style="padding: 30px 20px;">
                            <p>Liebe/r <strong>${customerName}</strong>,</p>
                            <p>vielen Dank für Ihr Vertrauen! Wir haben Ihre Anfrage erhalten und beginnen unmittelbar mit der Vernichtung Ihrer negativen Bewertungen.</p>
                            
                            <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; border-left: 4px solid #1DC3A3;">
                                <h3 style="margin-top: 0; color: #00277C;">📋 Ihre Auftragsdetails:</h3>
                                <ul style="margin: 0; padding-left: 20px;">
                                    <li style="margin: 8px 0;"><strong>Auftrags-ID:</strong> <span style="background: #1DC3A3; color: white; padding: 2px 6px; border-radius: 4px; font-weight: 600;">${orderId}</span></li>
                                    <li style="margin: 8px 0;"><strong>Unternehmen:</strong> ${businessName}</li>
                                    <li style="margin: 8px 0;"><strong>Anzahl Bewertungen:</strong> ${selectedReviews.length}</li>
                                    <li style="margin: 8px 0;"><strong>Gesamtpreis:</strong> €${calculatedPrice.toFixed(2)} (nur bei Erfolg)</li>
                                </ul>
                            </div>
                            
                            <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #856404; font-size: 18px;">⚠️ WICHTIGER HINWEIS!</h3>
                                <p style="color: #856404; font-weight: 600; margin-bottom: 15px;">
                                    <strong>Falls Sie Kommentare zu den betroffenen negativen Bewertungen hinterlassen haben, bitten wir Sie dringend, diese umgehend zu löschen!</strong> 
                                    Kommentare reduzieren die Erfolgschancen einer Löschung erheblich.
                                </p>
                                
                                <div style="background: white; border-radius: 6px; padding: 15px; margin: 15px 0;">
                                    <h4 style="margin-top: 0; color: #856404;">📝 Anleitung zum Löschen von Kommentaren:</h4>
                                    <ol style="color: #856404; margin: 0; padding-left: 20px;">
                                        <li>Melden Sie sich in Ihrem Google-Business Account an: <br><a href="https://business.google.com/reviews/" style="color: #00277C;">https://business.google.com/reviews/</a></li>
                                        <li>Wählen Sie im Seitenmenü <strong>"Rezensionen verwalten"</strong> oder <strong>"Rezensionen"</strong></li>
                                        <li>Suchen Sie die betroffene Bewertung und löschen Sie den Kommentar über die Schaltfläche <strong>"Löschen"</strong></li>
                                    </ol>
                                </div>
                                
                                <p style="color: #856404; font-weight: 600; margin-bottom: 0;">
                                    💬 <strong>Geben Sie uns kurz Bescheid, sobald die Kommentare entfernt wurden, sollten Sie zuvor welche hinterlassen haben</strong>, damit wir umgehend mit der Löschung fortfahren können!
                                </p>
                            </div>
                            
                            <div style="background: linear-gradient(135deg, #e8f5e8 0%, #f0fff4 100%); border: 1px solid #1DC3A3; border-radius: 8px; padding: 20px; margin: 20px 0;">
                                <h3 style="margin-top: 0; color: #00277C;">⚔️ Was passiert als Nächstes?</h3>
                                <ol style="margin: 0; padding-left: 20px;">
                                    <li style="margin: 10px 0; font-weight: 500;">Unser Expertenteam beginnt sofort mit der Analyse und Entfernung</li>
                                    <li style="margin: 10px 0; font-weight: 500;">Erste Ergebnisse binnen 1 Stunde</li>
                                    <li style="margin: 10px 0; font-weight: 500;">Vollständige Bearbeitung binnen 24 Stunden</li>
                                    <li style="margin: 10px 0; font-weight: 500;">Sie zahlen nur bei erfolgreichem Ergebnis</li>
                                </ol>
                            </div>
                            
                            <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 20px; margin: 20px 0;">
                                <p style="margin: 0; margin-bottom: 10px;"><strong>Bei Fragen erreichen Sie uns unter:</strong></p>
                                <ul style="margin: 10px 0 0 0; padding-left: 20px;">
                                    <li style="margin: 5px 0;">📧 info@rufheld.de</li>
                                    <li style="margin: 5px 0;">📱 +49 1512 9658221</li>
                                    <li style="margin: 5px 0;">💬 <a href="https://wa.me/4915129658221" style="color: #00277C; text-decoration: none;">WhatsApp</a></li>
                                </ul>
                            </div>
                        </div>
                        
                        <div style="background: #00277C; color: white; padding: 20px; text-align: center; font-weight: 600;">
                            Vielen Dank für Ihr Vertrauen!<br>
                            Ihr Rufheld Team 🛡️
                        </div>
                    </div>
                `;

                // Admin notification email HTML
                const notificationEmailHtml = `
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); overflow: hidden;">
                        <div style="background: linear-gradient(135deg, #dc3545 0%, #ff6b7a 100%); color: white; padding: 25px 20px; text-align: center;">
                            <h2 style="margin: 0; font-size: 28px;">🚨 NEUER AUFTRAG EINGEGANGEN!</h2>
                        </div>
                        
                        <div style="padding: 30px 20px;">
                            <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 15px; margin: 0 0 25px 0; text-align: center; font-weight: 600; color: #856404; font-size: 18px;">
                                ⏰ SOFORTIGE AUFMERKSAMKEIT ERFORDERLICH ⏰
                            </div>
                            
                            <h3 style="color: #00277C; margin-bottom: 15px; font-size: 20px; border-bottom: 2px solid #1DC3A3; padding-bottom: 5px;">👤 Kundendetails:</h3>
                            <div style="background: #f8f9fa; border-radius: 8px; padding: 15px; margin: 15px 0; border-left: 4px solid #1DC3A3;">
                                <strong style="color: #00277C;">Auftrags-ID:</strong> ${orderId}<br>
                                <strong style="color: #00277C;">Name:</strong> ${customerName}<br>
                                <strong style="color: #00277C;">Email:</strong> ${customerEmail}<br>
                                <strong style="color: #00277C;">Telefon:</strong> ${customerPhone}<br>
                                <strong style="color: #00277C;">Unternehmen:</strong> ${businessName}
                            </div>
                            
                            <h3 style="color: #00277C; margin-bottom: 15px; font-size: 20px; border-bottom: 2px solid #1DC3A3; padding-bottom: 5px;">💼 Auftragsdetails:</h3>
                            <div style="background: #f8f9fa; border-radius: 8px; padding: 15px; margin: 15px 0; border-left: 4px solid #1DC3A3;">
                                <strong style="color: #00277C;">Anzahl Reviews:</strong> ${selectedReviews.length} negative Bewertungen<br>
                                <strong style="color: #00277C;">Google Place ID:</strong> ${businessPlaceId}
                            </div>
                            
                            <div style="background: linear-gradient(135deg, #00277C 0%, #1DC3A3 100%); color: white; padding: 15px; border-radius: 8px; text-align: center; font-size: 20px; font-weight: 700; margin: 20px 0;">
                                💰 Gesamtwert: €${calculatedPrice.toFixed(2)}
                            </div>
                            
                            <h3 style="color: #00277C; margin-bottom: 15px; font-size: 20px; border-bottom: 2px solid #1DC3A3; padding-bottom: 5px;">📝 Ausgewählte Reviews:</h3>
                            ${selectedReviews.map((review, index) => `
                                <div style="background: #fff5f5; border: 1px solid #fecaca; border-radius: 8px; padding: 15px; margin: 10px 0; border-left: 4px solid #dc3545;">
                                    <div style="font-weight: 600; color: #dc3545; margin-bottom: 8px;">⭐ ${review.rating} ${review.rating === 1 ? 'Stern' : 'Sterne'} von ${review.reviewerName || review.reviewer || 'Unbekannt'}</div>
                                    <div style="color: #666; font-style: italic; background: white; padding: 10px; border-radius: 4px; border-left: 3px solid #dc3545;">
                                        "${review.reviewText || review.text ? (review.reviewText || review.text).substring(0, 150) + ((review.reviewText || review.text).length > 150 ? '...' : '') : 'Kein Text'}"
                                    </div>
                                </div>
                            `).join('')}
                            
                            <div style="background: #dc3545; color: white; padding: 20px; border-radius: 8px; text-align: center; font-weight: 600; font-size: 18px; margin: 25px 0;">
                                🚀 <strong>SOFORT HANDELN:</strong> Kunde erwartet Ergebnisse binnen 24h!
                            </div>
                        </div>
                    </div>
                `;

                // Send customer confirmation email
                await emailTransporter.sendMail({
                    from: '"Rufheld" <info@rufheld.de>',
                    replyTo: 'info@rufheld.de',
                    to: customerEmail,
                    subject: `✅ Auftrag ${orderId} erhalten - Rufheld vernichtet Ihre negativen Bewertungen`,
                    html: customerEmailHtml,
                    headers: {
                        'X-Priority': '1',
                        'X-MSMail-Priority': 'High',
                        'Importance': 'high'
                    }
                });
                console.log('✅ Customer confirmation email sent to:', customerEmail);

                // Send admin notification email
                if (process.env.NOTIFICATION_EMAIL) {
                    await emailTransporter.sendMail({
                        from: '"Rufheld Backend" <info@rufheld.de>',
                        replyTo: 'info@rufheld.de',
                        to: process.env.NOTIFICATION_EMAIL,
                        subject: `🚨 NEUER AUFTRAG: ${customerName} - ${selectedReviews.length} Reviews (€${calculatedPrice.toFixed(2)})`,
                        html: notificationEmailHtml,
                        headers: {
                            'X-Priority': '1',
                            'X-MSMail-Priority': 'High',
                            'Importance': 'high'
                        }
                    });
                    console.log('✅ Admin notification email sent to:', process.env.NOTIFICATION_EMAIL);
                }

                console.log('✅ All emails sent successfully');
            } catch (emailError) {
                console.error('❌ Email sending failed:', emailError);
                // Continue anyway - don't fail the request
            }
        }

        // Return success response
        res.json({
            success: true,
            message: 'Anfrage erfolgreich eingereicht.',
            orderId: orderId,
            totalPrice: calculatedPrice,
            reviewCount: selectedReviews.length,
            estimatedProcessingTime: '24 Stunden'
        });

    } catch (error) {
        console.error('❌ Error submitting order:', error);
        res.status(500).json({
            success: false,
            error: 'Fehler beim Verarbeiten der Anfrage.'
        });
    }
});

// Route: Admin panel to view all orders
app.get('/api/admin/orders', async (req, res) => {
    if (!pool) {
        return res.status(503).json({
            success: false,
            error: 'Database not available'
        });
    }

    try {
        const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');
        res.json({
            success: true,
            orders: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({
            success: false,
            error: 'Fehler beim Laden der Bestellungen.'
        });
    }
});

// Route: Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        database: !!pool,
        email: !!emailTransporter
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

// Route: Admin panel mit detaillierten Review-Daten
app.get('/api/admin/orders-detailed', async (req, res) => {
    if (!pool) {
        return res.status(503).json({
            success: false,
            error: 'Database not available'
        });
    }

    try {
        const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');
        
        // Format die Daten schön lesbar
        const detailedOrders = result.rows.map(order => {
            // selected_reviews ist bereits ein Object, kein String!
            const selectedReviews = order.selected_reviews;
            
            return {
                auftragsDetails: {
                    id: order.id,
                    auftragId: order.order_id,
                    unternehmen: order.business_name,
                    placeId: order.business_place_id,
                    gesamtpreis: `€${order.total_price}`,
                    anzahlReviews: order.review_count,
                    status: order.status,
                    bestelldatum: new Date(order.created_at).toLocaleString('de-DE')
                },
                kundenDetails: {
                    name: order.customer_name,
                    email: order.customer_email,
                    telefon: order.customer_phone
                },
                reviewDetails: selectedReviews.map((review, index) => ({
                    nummer: index + 1,
                    reviewId: review.id || 'Keine ID',
                    bewertung: `${review.rating} ${review.rating === 1 ? 'Stern' : 'Sterne'}`,
                    bewerterName: review.reviewer || review.reviewerName || 'Unbekannt',
                    reviewText: review.text || review.reviewText || 'Kein Text',
                    reviewUrl: review.url || 'Keine URL',
                    reviewerId: review.reviewer_id || 'Keine ID',
                    datum: review.datetime || 'Unbekannt',
                    likes: review.likes || 0
                }))
            };
        });

        res.json({
            success: true,
            orders: detailedOrders,
            total: detailedOrders.length,
            hinweis: 'Alle Review-Details sind hier vollständig sichtbar'
        });

    } catch (error) {
        console.error('Error fetching detailed orders:', error);
        res.status(500).json({
            success: false,
            error: 'Fehler beim Laden der detaillierten Bestellungen.'
        });
    }
});

// Route: Einzelne Bestellung mit allen Details
app.get('/api/admin/order/:orderId', async (req, res) => {
    if (!pool) {
        return res.status(503).json({
            success: false,
            error: 'Database not available'
        });
    }

    try {
        const { orderId } = req.params;
        const result = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Bestellung nicht gefunden'
            });
        }

        const order = result.rows[0];
        const selectedReviews = JSON.parse(order.selected_reviews);
        
        res.json({
            success: true,
            auftrag: {
                id: order.id,
                auftragId: order.order_id,
                unternehmen: order.business_name,
                placeId: order.business_place_id,
                kunde: {
                    name: order.customer_name,
                    email: order.customer_email,
                    telefon: order.customer_phone
                },
                preis: {
                    gesamt: `€${order.total_price}`,
                    proReview: '€39.99',
                    anzahl: order.review_count
                },
                status: order.status,
                erstellt: new Date(order.created_at).toLocaleString('de-DE'),
                aktualisiert: new Date(order.updated_at).toLocaleString('de-DE')
            },
            reviews: selectedReviews.map((review, index) => ({
                nummer: index + 1,
                details: {
                    id: review.id || 'Keine ID',
                    url: review.url || 'Keine URL',
                    bewertung: review.rating,
                    sterne: `${review.rating} ${review.rating === 1 ? 'Stern' : 'Sterne'}`,
                    datum: review.datetime || 'Unbekannt'
                },
                bewerter: {
                    name: review.reviewer || review.reviewerName || 'Unbekannt',
                    id: review.reviewer_id || 'Keine ID'
                },
                inhalt: {
                    text: review.text || review.reviewText || 'Kein Text',
                    likes: review.likes || 0,
                    länge: (review.text || review.reviewText || '').length
                }
            }))
        });

    } catch (error) {
        console.error('Error fetching order details:', error);
        res.status(500).json({
            success: false,
            error: 'Fehler beim Laden der Bestellungsdetails.'
        });
    }
});


// DEBUGGING: Zeige raw selected_reviews Daten (korrigiert)
app.get('/api/debug/orders-raw', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, order_id, selected_reviews FROM orders ORDER BY created_at DESC LIMIT 5');
        
        res.json({
            success: true,
            debug: result.rows.map(row => ({
                id: row.id,
                order_id: row.order_id,
                selected_reviews_type: typeof row.selected_reviews,
                selected_reviews_raw: row.selected_reviews,
                is_string: typeof row.selected_reviews === 'string',
                is_object: typeof row.selected_reviews === 'object',
                preview: row.selected_reviews ? JSON.stringify(row.selected_reviews).substring(0, 200) : 'NULL'
            }))
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            stack: error.stack
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
    console.log(`💾 Database: ${pool ? 'Connected' : 'Not configured'}`);
    console.log(`📧 Email: ${emailTransporter ? 'Configured' : 'Not configured'}`);
});

module.exports = app;

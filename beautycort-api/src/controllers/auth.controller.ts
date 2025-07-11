import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../middleware/error.middleware';
import { ApiResponse } from '../types';
import { db, auth } from '../config/supabase-simple';
import { mockOTP } from '../config/mock-otp';

// Interfaces for request bodies

interface ProviderSignupRequest {
  email: string;
  password: string;
  phone: string;
  business_name_ar: string;
  business_name_en: string;
  owner_name: string;
  latitude: number;
  longitude: number;
  address: {
    street: string;
    city: string;
    district: string;
    country: string;
  };
  license_number?: string;
}

interface CustomerLoginRequest {
  phone: string;
}

interface ProviderLoginRequest {
  email: string;
  password: string;
}

interface JWTPayload {
  id: string;
  type: 'customer' | 'provider';
  phone?: string;
  email?: string;
}

export class AuthController {
  private readonly JWT_SECRET = process.env.JWT_SECRET || 'default-secret';
  private readonly JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

  /**
   * Validate Jordan phone number format
   * Accepts: +962XXXXXXXXX, 962XXXXXXXXX, 07XXXXXXXX, 7XXXXXXXX
   */
  private validateJordanPhoneNumber(phone: string): string {
    // Remove all non-digit characters
    let cleaned = phone.replace(/\D/g, '');
    
    // Handle different formats
    if (cleaned.startsWith('962')) {
      // Already has country code
      cleaned = '+' + cleaned;
    } else if (cleaned.startsWith('07')) {
      // Local format with 0
      cleaned = '+962' + cleaned.substring(1);
    } else if (cleaned.startsWith('7') && cleaned.length === 9) {
      // Local format without 0
      cleaned = '+962' + cleaned;
    } else {
      throw new AppError('Invalid phone number format. Please use Jordan format (e.g., 0791234567)', 400);
    }
    
    // Validate final format: +962XXXXXXXXX (12 digits total with +)
    const jordanPhoneRegex = /^\+962[7][0-9]{8}$/;
    if (!jordanPhoneRegex.test(cleaned)) {
      throw new AppError('Invalid Jordan mobile number. Must be a valid Jordanian mobile number', 400);
    }
    
    return cleaned;
  }

  /**
   * Generate JWT token
   */
  private generateToken(payload: JWTPayload): string {
    return jwt.sign(
      payload, 
      this.JWT_SECRET, 
      { expiresIn: this.JWT_EXPIRES_IN } as jwt.SignOptions
    );
  }

  /**
   * Send OTP to customer phone number
   */
  async customerSendOTP(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { phone } = req.body;
      
      // Validate phone format (Jordan, US test, or Spanish test)
      const jordanPhoneRegex = /^\+962[7-9][0-9]{8}$/;
      const testUSPhoneRegex = /^\+1[0-9]{10}$/;
      const testSpanishPhoneRegex = /^\+34[0-9]{9}$/;
      
      if (!jordanPhoneRegex.test(phone) && !testUSPhoneRegex.test(phone) && !testSpanishPhoneRegex.test(phone)) {
        throw new AppError('Invalid phone number. Format: +962XXXXXXXXX (Jordan), +1XXXXXXXXXX (US), or +34XXXXXXXXX (Spain)', 400);
      }
      
      // Log if using test number
      if (testUSPhoneRegex.test(phone) || testSpanishPhoneRegex.test(phone)) {
        console.log('⚠️  Using test phone number for development:', phone);
      }
      
      // Send OTP using the auth object
      console.log('📱 Attempting to send OTP to:', phone);
      const { data, error } = await auth.signInWithOtp({ phone });
      
      if (error) {
        console.error('❌ OTP Error:', error);
        throw new AppError(`Failed to send OTP: ${error.message}`, 400);
      }
      
      console.log('✅ OTP Response:', JSON.stringify(data, null, 2));
      
      // Check if SMS was actually sent
      if (!data || (!data.user && !data.session)) {
        console.log('⚠️  Supabase accepted request but no SMS sent');
        console.log('📋 Possible issues:');
        console.log('- Twilio messaging service might need phone number verification');
        console.log('- Phone number might need to be verified in Twilio');
        console.log('- Twilio account might be in trial mode with restrictions');
      }
      
      // Check if real SMS was sent
      if (data?.messageId) {
        console.log('📨 Real SMS sent! Message ID:', data.messageId);
        console.log('✅ Twilio integration working - use the SMS code you receive');
      } else if (mockOTP.isMockMode()) {
        console.log('📱 No real SMS sent - using mock OTP');
        mockOTP.generate(phone);
      }
      
      // In development mode with mock OTP, include the OTP in response for testing
      const responseData: any = { phone };
      if (mockOTP.isMockMode() && process.env.NODE_ENV === 'development') {
        const otpData = mockOTP.getStoredOTP(phone);
        if (otpData) {
          responseData.testOTP = otpData.otp;
          responseData.testMode = true;
          responseData.warning = "OTP included for testing only - never do this in production!";
        }
      }
      
      const response: ApiResponse = {
        success: true,
        message: 'OTP sent successfully to ' + phone,
        data: responseData
      };
      
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify OTP and create/fetch user
   */
  async verifyOTP(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { phone, otp } = req.body;
      
      // Try Supabase verification first (for real SMS)
      const { error: verifyError } = await auth.verifyOtp({ 
        phone, 
        token: otp 
      });
      
      // If Supabase verification fails and we're in mock mode, try mock OTP
      if (verifyError && mockOTP.isMockMode()) {
        console.log('📱 Trying mock OTP verification...');
        const isValid = mockOTP.verify(phone, otp);
        if (!isValid) {
          throw new AppError('Invalid or expired OTP', 400);
        }
      } else if (verifyError) {
        throw new AppError('Invalid or expired OTP', 400);
      } else {
        console.log('✅ Real OTP verified via Supabase/Twilio!');
      }
      
      // Now create or fetch the user
      const { data: user, error: userError } = await auth.createCustomerAfterOtp(
        phone,
        { name: req.body.name || 'User' }
      );
      
      if (userError) {
        throw new AppError('Failed to create user account', 500);
      }
      
      // Generate JWT token
      const token = this.generateToken({
        id: (user as any).id,
        type: 'customer',
        phone: (user as any).phone,
      });
      
      const response: ApiResponse = {
        success: true,
        message: 'Phone verified successfully',
        data: {
          user,
          token,
        }
      };
      
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Provider signup with email and password
   */
  async providerSignup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const providerData: ProviderSignupRequest = req.body;

      // Validate phone number
      const validatedPhone = this.validateJordanPhoneNumber(providerData.phone);

      // Check if email already exists
      const { data: existingProvider } = await db.providers.findByEmail(providerData.email);
      if (existingProvider) {
        throw new AppError('Email already registered', 409);
      }

      // Check if phone already exists
      const { data: existingPhone } = await db.providers.findByPhone(validatedPhone);
      if (existingPhone) {
        throw new AppError('Phone number already registered', 409);
      }

      // Create provider with Supabase Auth
      const { data: result, error } = await auth.signUpProvider({
        ...providerData,
        phone: validatedPhone,
      });

      // In development mode, create mock provider if Supabase fails
      if ((error || !result) && process.env.NODE_ENV === 'development') {
        console.log('⚠️  Supabase provider signup failed, using mock data');
        const mockProvider = {
          provider: {
            id: 'mock-provider-' + Date.now(),
            email: providerData.email,
            business_name_ar: providerData.business_name_ar,
            business_name_en: providerData.business_name_en,
            owner_name: providerData.owner_name,
            phone: validatedPhone,
            address: providerData.address,
            latitude: providerData.latitude,
            longitude: providerData.longitude,
            created_at: new Date().toISOString(),
          }
        };
        
        // Generate JWT token for mock provider
        const token = this.generateToken({
          id: mockProvider.provider.id,
          type: 'provider',
          email: mockProvider.provider.email,
        });

        const response: ApiResponse = {
          success: true,
          data: {
            provider: mockProvider.provider,
            token,
            mockMode: true,
          }
        };
        
        res.status(201).json(response);
        return;
      }

      if (error || !result) {
        const errorMessage = error && typeof error === 'object' && 'message' in error 
          ? (error as any).message 
          : 'Failed to create provider account';
        throw new AppError(errorMessage, 500);
      }

      // Generate JWT token
      const token = this.generateToken({
        id: result.provider.id,
        type: 'provider',
        email: result.provider.email,
      });

      const response: ApiResponse = {
        success: true,
        data: {
          provider: {
            id: result.provider.id,
            business_name_ar: result.provider.business_name_ar,
            business_name_en: result.provider.business_name_en,
            owner_name: result.provider.owner_name,
            phone: result.provider.phone,
            email: result.provider.email,
            verified: result.provider.verified,
          },
          token,
          type: 'provider',
        },
        message: 'Provider account created successfully. Pending verification.',
      };

      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Customer login with phone number (OTP would be sent in production)
   */
  async customerLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { phone }: CustomerLoginRequest = req.body;

      // Validate phone number
      const validatedPhone = this.validateJordanPhoneNumber(phone);

      // Find user by phone
      const { data: userData, error } = await db.users.findByPhone(validatedPhone);
      
      if (error || !userData) {
        throw new AppError('Phone number not registered', 404);
      }
      
      const user = userData as any;

      // In production, you would:
      // 1. Generate and send OTP via SMS
      // 2. Store OTP temporarily (Redis/Database)
      // 3. Have separate endpoint to verify OTP
      
      // For development, we'll generate token directly
      const token = this.generateToken({
        id: user.id,
        type: 'customer',
        phone: user.phone,
      });

      const response: ApiResponse = {
        success: true,
        data: {
          user: {
            id: user.id,
            phone: user.phone,
            name: user.name,
            email: user.email,
            language: user.language,
          },
          token,
          type: 'customer',
        },
        message: 'Login successful',
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Provider login with email and password
   */
  async providerLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password }: ProviderLoginRequest = req.body;

      // Sign in with Supabase Auth
      const { data: result, error } = await auth.signInProvider(email, password);

      // In development mode, allow mock login
      if ((error || !result) && process.env.NODE_ENV === 'development') {
        console.log('⚠️  Using mock provider login for development');
        
        // Create mock provider data for testing
        const mockProvider = {
          provider: {
            id: 'mock-provider-' + Date.now(),
            email: email,
            business_name_ar: 'صالون تجميل تجريبي',
            business_name_en: 'Test Beauty Salon',
            owner_name: 'Test Owner',
            phone: '+962790000000',
            verified: true,
            created_at: new Date().toISOString(),
          }
        };
        
        // Generate JWT token
        const token = this.generateToken({
          id: mockProvider.provider.id,
          type: 'provider',
          email: mockProvider.provider.email,
        });

        const response: ApiResponse = {
          success: true,
          data: {
            provider: mockProvider.provider,
            token,
            mockMode: true,
          }
        };
        
        res.json(response);
        return;
      }

      if (error || !result) {
        throw new AppError('Invalid email or password', 401);
      }

      // Check if provider is verified
      if (!result.provider.verified) {
        throw new AppError('Provider account not verified. Please contact support.', 403);
      }

      // Generate JWT token
      const token = this.generateToken({
        id: result.provider.id,
        type: 'provider',
        email: result.provider.email,
      });

      const response: ApiResponse = {
        success: true,
        data: {
          provider: {
            id: result.provider.id,
            business_name_ar: result.provider.business_name_ar,
            business_name_en: result.provider.business_name_en,
            owner_name: result.provider.owner_name,
            phone: result.provider.phone,
            email: result.provider.email,
            rating: result.provider.rating,
            total_reviews: result.provider.total_reviews,
          },
          token,
          type: 'provider',
        },
        message: 'Login successful',
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }


  /**
   * Refresh JWT token
   */
  async refreshToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        throw new AppError('Refresh token required', 400);
      }

      // Verify refresh token
      const decoded = jwt.verify(refreshToken, this.JWT_SECRET) as JWTPayload;

      // Generate new token
      const newToken = this.generateToken({
        id: decoded.id,
        type: decoded.type,
        phone: decoded.phone,
        email: decoded.email,
      });

      const response: ApiResponse = {
        success: true,
        data: {
          token: newToken,
        },
      };

      res.json(response);
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        next(new AppError('Invalid refresh token', 401));
      } else {
        next(error);
      }
    }
  }

  /**
   * Logout (mainly for providers using Supabase Auth)
   */
  async logout(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Sign out from Supabase (if using Supabase session)
      await auth.signOut();

      // In production, you might want to:
      // 1. Blacklist the JWT token
      // 2. Clear any server-side sessions
      // 3. Revoke refresh tokens

      const response: ApiResponse = {
        success: true,
        message: 'Logout successful',
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Request password reset for providers
   */
  async forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email } = req.body;

      // Check if provider exists
      const { data: provider } = await db.providers.findByEmail(email);
      
      if (!provider) {
        // Don't reveal if email exists for security
        const response: ApiResponse = {
          success: true,
          message: 'If the email exists, a password reset link will be sent',
        };
        res.json(response);
        return;
      }

      // TODO: In production:
      // 1. Generate reset token
      // 2. Send email with reset link
      // 3. Store token with expiration

      const response: ApiResponse = {
        success: true,
        message: 'Password reset instructions sent to your email',
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reset password for providers
   */
  async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, newPassword } = req.body;

      // TODO: In production:
      // 1. Verify reset token
      // 2. Check token expiration
      // 3. Update password in Supabase Auth
      // 4. Invalidate reset token

      if (!token || token.length < 32) {
        throw new AppError('Invalid or expired reset token', 400);
      }

      if (!newPassword || newPassword.length < 6) {
        throw new AppError('Password must be at least 6 characters long', 400);
      }

      const response: ApiResponse = {
        success: true,
        message: 'Password reset successful. Please login with your new password.',
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
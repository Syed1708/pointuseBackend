const User = require("../models/User");
const jwt = require("jsonwebtoken");

const generateAccessToken = (user) => {
  return jwt.sign(
    { id: user._id, role: user.role },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: "15m" },
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign({ id: user._id }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: "7d",
  });
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).populate("role");

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Save refresh token to the database
    user.refreshToken = refreshToken;
    await user.save();

    // Send access token in JSON and refresh token in an HTTP-only cookie (secure for web)
    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: isProduction, // Use secure in production
      sameSite: isProduction ? "none" : "lax", // 🛑 MUST be 'lax' for local cross-port to work, 'none' for production cross-site
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // We also return the tokens in the response body so React Native can store it securely
    res.json({
      message: "Logged in successfully",
      accessToken,
      refreshToken, // React Native will save this locally
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.refreshToken = async (req, res) => {
  try {
    // Get refresh token from either cookies (Web) or body (Mobile)
    const token = req.cookies.refreshToken || req.body.refreshToken;

    if (!token) {
      return res.status(401).json({ message: "Refresh token required" });
    }

    const user = await User.findOne({ refreshToken: token });
    if (!user) {
      return res.status(403).json({ message: "Invalid refresh token" });
    }

    jwt.verify(token, process.env.REFRESH_TOKEN_SECRET, (err, decoded) => {
      if (err)
        return res
          .status(403)
          .json({ message: "Invalid or expired refresh token" });

      const newAccessToken = generateAccessToken(user);
      res.json({ accessToken: newAccessToken });
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.logout = async (req, res) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    if (token) {
      const user = await User.findOne({ refreshToken: token });
      if (user) {
        user.refreshToken = null;
        await user.save();
      }
    }
    res.clearCookie("refreshToken");
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};

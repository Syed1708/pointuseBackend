const mongoose = require('mongoose');

const swapRequestSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },       // Employee A (Initiator)
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },     // Employee B (Partner)
  
  // Sender's original shift details
  senderDate: { type: String, required: true },      // "YYYY-MM-DD"
  senderShiftIndex: { type: Number, required: true }, 

  // Receiver's original shift details
  receiverDate: { type: String, required: true },    // "YYYY-MM-DD"
  receiverShiftIndex: { type: Number, required: true },

  // Status Lifecycle
  status: { 
    type: String, 
    enum: ['pending_receiver', 'pending_manager', 'approved', 'rejected'], 
    default: 'pending_receiver' 
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

module.exports = mongoose.model('SwapRequest', swapRequestSchema);
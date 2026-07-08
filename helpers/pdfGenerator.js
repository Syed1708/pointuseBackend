const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const Settings = require('../models/Settings');

// Helper: Calculate ISO week number
const getWeekNumber = (d) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
};

// Helper: Format Single Days (e.g. "Monday - 22-06")
const getDayDateString = (mondayString, offsetDays) => {
  const date = new Date(mondayString);
  date.setDate(date.getDate() + offsetDays);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}`;
};

// Helper: Format Week Ranges (e.g. "22-06-2026 to 28-06-2026")
const getWeekRangeString = (mondayString) => {
  const start = new Date(mondayString);
  const end = new Date(mondayString);
  end.setDate(end.getDate() + 6);
  
  const formatDate = (d) => {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}-${month}-${d.getFullYear()}`;
  };
  return `${formatDate(start)} to ${formatDate(end)}`;
};

// Helper: Safe Fallback for Row Hours Calculation
const calculateRowHours = (days = {}) => {
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return weekdays.reduce((sum, dayKey) => {
    const day = days[dayKey] || { isOff: true }; 
    if (day.isOff) return sum;
    if (day.isLeave) return sum + (day.leaveHours || 0);
    
    let daySum = 0;
    day.shifts?.forEach(s => {
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      let diff = (eh * 60 + em) - (sh * 60 + sm);
      if (diff < 0) diff += 24 * 60;
      daySum += (diff - (s.breakMinutes || 0));
    });
    return sum + (daySum / 60);
  }, 0);
};

// Shared Header Drawer Component
const drawPDFHeader = (doc, settings, startX, startY) => {
  const companyName = settings?.name || 'Pointuse Restaurant Group';
  const companyAddress = settings?.address || '123 Street Name, City, Country';
  
  let textX = startX;

  if (settings?.logo && settings.logo.includes('/uploads/')) {
    try {
      const logoFilename = settings.logo.split('/uploads/')[1];
      const logoPath = path.join(__dirname, '../uploads', logoFilename);

      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, startX, startY, { width: 35, height: 35 });
        textX = startX + 45; 
      }
    } catch (e) {
      console.error('Error drawing brand logo in PDF:', e.message);
    }
  }

  doc.fillColor('#09090b');
  doc.fontSize(14).font('Helvetica-Bold').text(companyName, textX, startY);
  doc.fillColor('#71717a');
  doc.fontSize(8).font('Helvetica').text(companyAddress, textX, startY + 16);
};

// =========================================================================
// 1. LANDSCAPE WIDE GRID (For Managers - Upgraded for Multi-Page Pagination) [1, 2]
// =========================================================================
const generateSchedulePDF = (gridData, weekStartDate) => {
  return new Promise(async (resolve, reject) => {
    try {
      // 🛑 Set autoPageBreaks to false to take 100% manual control over drawing [1]
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, autoPageBreaks: false });
      const buffers = [];
      
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const monday = new Date(weekStartDate);
      const weekNo = getWeekNumber(monday);
      const range = getWeekRangeString(monday);

      // Fetch dynamic settings
      const settings = await Settings.findOne({ key: 'restaurant_config' });

      // Draw initial page headers
      drawPDFHeader(doc, settings, 30, 20);

      doc.fillColor('#09090b');
      doc.fontSize(11).font('Helvetica-Bold').text(`Semaine de ${weekNo} - ${range}`, 30, 62);
      doc.fillColor('#71717a');
      doc.fontSize(8).font('Helvetica').text('Pointuse Scheduling • Weekly Workforce Matrix', 30, 75);

      let startX = 30;
      let startY = 85; 
      const colWidths = { employee: 110, day: 84, total: 60 };
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

      // Draw initial table header
      doc.rect(startX, startY, 778, 24).fill('#18181b');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);

      doc.text('Employee / Contract', startX + 10, startY + 8, { width: colWidths.employee });
      days.forEach((day, idx) => {
        const dateStr = getDayDateString(monday, idx);
        const cellX = startX + colWidths.employee + (idx * colWidths.day);
        doc.text(`${day} - ${dateStr}`, cellX, startY + 8, { width: colWidths.day, align: 'center' });
      });
      doc.text('Total', startX + colWidths.employee + (7 * colWidths.day), startY + 8, { width: colWidths.total, align: 'center' });

      let currentY = startY + 24;

      // Draw Grid Rows
      gridData.forEach((item) => {
        const rowHeight = 60; 

        // 🛑 AUTOMATIC PAGE-BREAK CHECKER [2]
        // If drawing the next row exceeds our page safety limit of 530, we add a new page [2]
        if (currentY + rowHeight > 530) {
          doc.addPage({ size: 'A4', layout: 'landscape', margin: 30, autoPageBreaks: false });
          
          // Re-draw branding header on new page [2]
          drawPDFHeader(doc, settings, 30, 20);

          // Re-draw table header on new page
          doc.rect(startX, startY, 778, 24).fill('#18181b');
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);

          doc.text('Employee / Contract', startX + 10, startY + 8, { width: colWidths.employee });
          days.forEach((day, idx) => {
            const dateStr = getDayDateString(monday, idx);
            const cellX = startX + colWidths.employee + (idx * colWidths.day);
            doc.text(`${day} - ${dateStr}`, cellX, startY + 8, { width: colWidths.day, align: 'center' });
          });
          doc.text('Total', startX + colWidths.employee + (7 * colWidths.day), startY + 8, { width: colWidths.total, align: 'center' });

          // Reset currentY back to the top of the new page [2]
          currentY = startY + 24; 
        }

        // Draw Row Card Outline
        doc.rect(startX, currentY, 778, rowHeight).lineWidth(0.5).strokeColor('#e4e4e7').stroke();

        // Render Employee info
        doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(9);
        doc.text(item.employee.name, startX + 10, currentY + 16, { width: colWidths.employee - 10 });
        
        const contractHours = item.employee.contractHours || 35;
        doc.fillColor('#a1a1aa').font('Helvetica-Bold').fontSize(7);
        doc.text(`${contractHours}h Contract`, startX + 10, currentY + 30, { width: colWidths.employee - 10 });

        const weekdaysKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        weekdaysKeys.forEach((dayKey, idx) => {
          const day = (item.schedule && item.schedule.days && item.schedule.days[dayKey]) || { isOff: true, shifts: [] };
          const cellX = startX + colWidths.employee + (idx * colWidths.day);

          if (day.isOff) {
            doc.fillColor('#71717a').font('Helvetica').fontSize(8);
            doc.text('Repos', cellX, currentY + 25, { width: colWidths.day, align: 'center' });
          } else if (day.isLeave) {
            doc.fillColor('#b45309').font('Helvetica-Bold').fontSize(8);
            doc.text(`Congé (${day.leaveHours}h)`, cellX, currentY + 25, { width: colWidths.day, align: 'center' });
          } else if (day.shifts && day.shifts.length > 0) {
            if (day.shifts.length === 1) {
              const s1 = day.shifts[0];
              doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(8);
              doc.text(`${s1.startTime} - ${s1.endTime}`, cellX, currentY + 18, { width: colWidths.day, align: 'center' });
              doc.fillColor('#71717a').font('Helvetica').fontSize(7);
              doc.text(`${s1.task} (${s1.breakMinutes}m)`, cellX, currentY + 28, { width: colWidths.day, align: 'center' });
            } 
            else if (day.shifts.length >= 2) {
              const s1 = day.shifts[0];
              const s2 = day.shifts[1];

              doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(7.5);
              doc.text(`${s1.startTime} - ${s1.endTime}`, cellX, currentY + 6, { width: colWidths.day, align: 'center' });
              doc.fillColor('#71717a').font('Helvetica').fontSize(6.5);
              doc.text(`${s1.task} (${s1.breakMinutes}m)`, cellX, currentY + 14, { width: colWidths.day, align: 'center' });

              doc.moveTo(cellX + 10, currentY + 28).lineTo(cellX + colWidths.day - 10, currentY + 28).lineWidth(0.5).strokeColor('#f4f4f5').stroke();

              doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(7.5);
              doc.text(`${s2.startTime} - ${s2.endTime}`, cellX, currentY + 34, { width: colWidths.day, align: 'center' });
              doc.fillColor('#71717a').font('Helvetica').fontSize(6.5);
              doc.text(`${s2.task} (${s2.breakMinutes}m)`, cellX, currentY + 42, { width: colWidths.day, align: 'center' });
            }
          }
        });

        const total = calculateRowHours(item.schedule ? item.schedule.days : {});
        doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(8.5);
        doc.text(`${total.toFixed(2)}h`, startX + colWidths.employee + (7 * colWidths.day), currentY + 25, { width: colWidths.total, align: 'center' });

        currentY += rowHeight;
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
};

// ==========================================
// 2. PORTRAIT COMPACT VIEW (For Employees)
// ==========================================
const generatePersonalPDF = (schedule, weekStartDate) => {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 40 });
      const buffers = [];
      
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const monday = new Date(weekStartDate);
      const weekNo = getWeekNumber(monday);
      const range = getWeekRangeString(monday);

      // Fetch dynamic settings from database
      const settings = await Settings.findOne({ key: 'restaurant_config' });

      // Draw beautiful dynamic branding header
      drawPDFHeader(doc, settings, 40, 30);

      // Document Sub-headers
      doc.fillColor('#09090b');
      doc.fontSize(12).font('Helvetica-Bold').text('My Personal Work Schedule', 40, 75);
      doc.fillColor('#71717a');
      doc.fontSize(8.5).font('Helvetica').text(`Employee: ${schedule.employee.name} (${schedule.employee.email})`, 40, 88);
      
      doc.fillColor('#09090b');
      doc.fontSize(10).font('Helvetica-Bold').text(`Semaine de ${weekNo} - ${range}`, 40, 105);

      doc.moveTo(40, 122).lineTo(555, 122).lineWidth(0.5).strokeColor('#e4e4e7').stroke();

      let currentY = 140; 
      const weekdaysKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

      weekdaysKeys.forEach((dayKey, idx) => {
        const day = schedule.days[dayKey] || { isOff: true, shifts: [] };
        const dateStr = getDayDateString(monday, idx);

        doc.rect(40, currentY, 515, 42).lineWidth(0.5).strokeColor('#e4e4e7').stroke();

        doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(9);
        doc.text(`${days[idx]} (${dateStr})`, 55, currentY + 16, { width: 130 });

        const shiftX = 200;
        if (day.isOff) {
          doc.fillColor('#71717a').font('Helvetica').fontSize(8.5).text('Repos', shiftX, currentY + 16, { width: 330 });
        } else if (day.isLeave) {
          doc.fillColor('#b45309').font('Helvetica-Bold').fontSize(8.5).text(`Congé (${day.leaveHours}h)`, shiftX, currentY + 16, { width: 330 });
        } else if (day.shifts && day.shifts.length > 0) {
          let textY = currentY + 6;
          day.shifts.forEach((s) => {
            doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(8).text(`${s.startTime} - ${s.endTime}`, shiftX, textY, { width: 80 });
            doc.fillColor('#71717a').font('Helvetica').fontSize(7.5).text(`${s.task} (Break: ${s.breakMinutes}m)`, shiftX + 90, textY + 0.5, { width: 230 });
            textY += 15;
          });
        }

        currentY += 47; 
      });

      doc.rect(40, currentY + 10, 515, 30).fill('#18181b');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
      doc.text(`Total Scheduled Hours This Week: ${schedule.totalHours.toFixed(2)} hrs`, 55, currentY + 20);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = { generateSchedulePDF, generatePersonalPDF, getWeekNumber, getWeekRangeString };
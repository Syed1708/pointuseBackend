const PDFDocument = require('pdfkit');

// Helper: Calculate ISO week number
const getWeekNumber = (d) => {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
};

// Helper: Get formatted date string for columns (e.g., "22/06")
const getDayDateString = (mondayString, offsetDays) => {
  const date = new Date(mondayString);
  date.setDate(date.getDate() + offsetDays);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
};

// Helper: Format full range (e.g. "22/06/2026 to 28/06/2026")
const getWeekRangeString = (mondayString) => {
  const start = new Date(mondayString);
  const end = new Date(mondayString);
  end.setDate(end.getDate() + 6);
  
  const formatDate = (d) => {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');const PDFDocument = require('pdfkit');

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

// 🛑 UPGRADED: Added safe fallback {} to parameters to prevent crashes
const calculateRowHours = (days = {}) => {
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return weekdays.reduce((sum, dayKey) => {
    // 🛑 Safe Fallback: If day is missing, default to Day Off (isOff: true)
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

const generateSchedulePDF = (gridData, weekStartDate) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
      const buffers = [];
      
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const monday = new Date(weekStartDate);
      const weekNo = getWeekNumber(monday);
      const range = getWeekRangeString(monday);

      // Company Headers
      const companyName = process.env.COMPANY_NAME || 'Pointuse Restaurant Group';
      const companyAddress = process.env.COMPANY_ADDRESS || '123 Street Name, City, Country';

      doc.fillColor('#09090b');
      doc.fontSize(14).font('Helvetica-Bold').text(companyName, 30, 20);
      doc.fillColor('#71717a');
      doc.fontSize(8).font('Helvetica').text(companyAddress, 30, 34);

      doc.fillColor('#09090b');
      doc.fontSize(11).font('Helvetica-Bold').text(`Semaine de ${weekNo} - ${range}`, 30, 52);
      doc.fillColor('#71717a');
      doc.fontSize(8).font('Helvetica').text('Pointuse Scheduling • Weekly Workforce Matrix', 30, 65);

      let startX = 30;
      let startY = 85; 
      
      const colWidths = {
        employee: 110,
        day: 84,       
        total: 60
      };

      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

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

      gridData.forEach((item) => {
        const rowHeight = 60; 
        
        doc.rect(startX, currentY, 778, rowHeight).lineWidth(0.5).strokeColor('#e4e4e7').stroke();

        doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(9);
        doc.text(item.employee.name, startX + 10, currentY + 16, { width: colWidths.employee - 10 });
        
        const contractHours = item.employee.contractHours || 35;
        doc.fillColor('#a1a1aa').font('Helvetica-Bold').fontSize(7);
        doc.text(`${contractHours}h Contract`, startX + 10, currentY + 30, { width: colWidths.employee - 10 });

        const weekdaysKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        
        weekdaysKeys.forEach((dayKey, idx) => {
          // 🛑 UPGRADED DYNAMIC DEFENSIVE CHECK:
          // If schedule, days, or dayKey is completely missing/empty, default safely to Day Off! [2]
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

              doc.moveTo(cellX + 10, currentY + 28)
                 .lineTo(cellX + colWidths.day - 10, currentY + 28)
                 .lineWidth(0.5)
                 .strokeColor('#f4f4f5')
                 .stroke();

              doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(7.5);
              doc.text(`${s2.startTime} - ${s2.endTime}`, cellX, currentY + 34, { width: colWidths.day, align: 'center' });
              doc.fillColor('#71717a').font('Helvetica').fontSize(6.5);
              doc.text(`${s2.task} (${s2.breakMinutes}m)`, cellX, currentY + 42, { width: colWidths.day, align: 'center' });
            }
          }
        });

        // 🛑 Safe horizontal total calculation
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

module.exports = { generateSchedulePDF, getWeekNumber, getWeekRangeString };
    return `${day}/${month}/${d.getFullYear()}`;
  };
  return `${formatDate(start)} to ${formatDate(end)}`;
};

const calculateRowHours = (days) => {
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  return weekdays.reduce((sum, dayKey) => {
    const day = days[dayKey];
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

// Main PDF Generator Stream-to-Buffer [1.2.4]
const generateSchedulePDF = (gridData, weekStartDate) => {
  return new Promise((resolve, reject) => {
    try {
      // Landscape A4 size setup [1.2.4]
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
      const buffers = [];
      
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const monday = new Date(weekStartDate);
      const weekNo = getWeekNumber(monday);
      const range = getWeekRangeString(monday);


// 🛑 1. Dynamic Company Name & Address Header [2]
      const companyName = process.env.COMPANY_NAME || 'Pointuse Restaurant Group';
      const companyAddress = process.env.COMPANY_ADDRESS || '123 Street Name, City, Country';

      doc.fillColor('#09090b');
      doc.fontSize(14).font('Helvetica-Bold').text(companyName, 30, 20);
      doc.fillColor('#71717a');
      doc.fontSize(8).font('Helvetica').text(companyAddress, 30, 34);

      // 🛑 2. Dynamic Weekly Subtitle
      doc.fillColor('#09090b');
      doc.fontSize(11).font('Helvetica-Bold').text(`Semaine de ${weekNo} - ${range}`, 30, 52);
      doc.fillColor('#71717a');
      doc.fontSize(8).font('Helvetica').text('Pointuse Scheduling • Weekly Workforce Matrix', 30, 65);
   

            // Grid Coordinates (Shifted down slightly to make room for company headers) [2]
      let startX = 30;
      let startY = 85; 
      
      const colWidths = {
        employee: 110,
        day: 84,       
        total: 60
      };


      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

      // Draw Main Header Background Box (Charcoal Theme) [2]
      doc.rect(startX, startY, 778, 24).fill('#18181b');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);

      // Header Labels (Perfect Center-aligned Layouts)
      doc.text('Employee / Contract', startX + 10, startY + 8, { width: colWidths.employee });
      days.forEach((day, idx) => {
        const dateStr = getDayDateString(monday, idx);
        const cellX = startX + colWidths.employee + (idx * colWidths.day);
        doc.text(`${day} - ${dateStr}`, cellX, startY + 8, { width: colWidths.day, align: 'center' });
      });
      doc.text('Total', startX + colWidths.employee + (7 * colWidths.day), startY + 8, { width: colWidths.total, align: 'center' });

      // Reset colors for rows
      let currentY = startY + 24;

      // Draw Grid Rows
       gridData.forEach((item) => {
        const rowHeight = 60; 
        
        // Draw Row Card Outline (Subtle Zinc Grey Border)
        doc.rect(startX, currentY, 778, rowHeight).lineWidth(0.5).strokeColor('#e4e4e7').stroke();

        // Render Employee info (Column 1)
        doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(9);
        doc.text(item.employee.name, startX + 10, currentY + 16, { width: colWidths.employee - 10 });
        
        // 🛑 3. POPULATE CONTRACT HOURS DYNAMICALLY IN PDF
        const contractHours = item.employee.contractHours || 35;
        doc.fillColor('#a1a1aa').font('Helvetica-Bold').fontSize(7);
        doc.text(`${contractHours}h Contract`, startX + 10, currentY + 30, { width: colWidths.employee - 10 });


        // 2. Render Calendar day columns
        const weekdaysKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        
        weekdaysKeys.forEach((dayKey, idx) => {
          const day = item.schedule.days[dayKey] || { isOff: true, shifts: [] };
          const cellX = startX + colWidths.employee + (idx * colWidths.day);

          if (day.isOff) {
            // Repos: Centered vertically
            doc.fillColor('#71717a').font('Helvetica').fontSize(8);
            doc.text('Repos', cellX, currentY + 25, { width: colWidths.day, align: 'center' });
          } else if (day.isLeave) {
            // Congé: Centered vertically in orange/amber
            doc.fillColor('#b45309').font('Helvetica-Bold').fontSize(8);
            doc.text(`Congé (${day.leaveHours}h)`, cellX, currentY + 25, { width: colWidths.day, align: 'center' });
          } else if (day.shifts && day.shifts.length > 0) {
            
            if (day.shifts.length === 1) {
              // 🛑 SINGLE SHIFT: Centered inside the cell
              const s1 = day.shifts[0];
              doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(8);
              doc.text(`${s1.startTime} - ${s1.endTime}`, cellX, currentY + 18, { width: colWidths.day, align: 'center' });
              
              doc.fillColor('#71717a').font('Helvetica').fontSize(7);
              doc.text(`${s1.task} (B:${s1.breakMinutes}m)`, cellX, currentY + 28, { width: colWidths.day, align: 'center' });
            } 
            else if (day.shifts.length >= 2) {
              // 🛑 SPLIT SHIFTS: Separated by a thin divider line
              const s1 = day.shifts[0];
              const s2 = day.shifts[1];

              // Render Shift 1 (Lunch)
              doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(7.5);
              doc.text(`${s1.startTime} - ${s1.endTime}`, cellX, currentY + 6, { width: colWidths.day, align: 'center' });
              doc.fillColor('#71717a').font('Helvetica').fontSize(6.5);
              doc.text(`${s1.task} (${s1.breakMinutes}m)`, cellX, currentY + 14, { width: colWidths.day, align: 'center' });

              // Draw subtle internal cell horizontal separator line [2]
              doc.moveTo(cellX + 10, currentY + 28)
                 .lineTo(cellX + colWidths.day - 10, currentY + 28)
                 .lineWidth(0.5)
                 .strokeColor('#f4f4f5')
                 .stroke();

              // Render Shift 2 (Dinner)
              doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(7.5);
              doc.text(`${s2.startTime} - ${s2.endTime}`, cellX, currentY + 34, { width: colWidths.day, align: 'center' });
              doc.fillColor('#71717a').font('Helvetica').fontSize(6.5);
              doc.text(`${s2.task} (${s2.breakMinutes}m)`, cellX, currentY + 42, { width: colWidths.day, align: 'center' });
            }
          }
        });

        // 3. Render Row Totals (Column 9 - Centered)
        const total = calculateRowHours(item.schedule.days);
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
// Append this function inside helpers/pdfGenerator.js:

const generatePersonalPDF = (schedule, weekStartDate) => {
  return new Promise((resolve, reject) => {
    try {
      // Create a clean Portrait A4 document [1.2.4]
      const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 40 });
      const buffers = [];
      
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const monday = new Date(weekStartDate);
      const weekNo = getWeekNumber(monday);
      const range = getWeekRangeString(monday);

      // Company Headers [2]
      const companyName = process.env.COMPANY_NAME || 'Pointuse Restaurant Group';
      const companyAddress = process.env.COMPANY_ADDRESS || '123 Street Name, City, Country';

      doc.fillColor('#09090b');
      doc.fontSize(14).font('Helvetica-Bold').text(companyName, 40, 30);
      doc.fillColor('#71717a');
      doc.fontSize(8).font('Helvetica').text(companyAddress, 40, 44);

      // Document Sub-headers
      doc.fillColor('#09090b');
      doc.fontSize(12).font('Helvetica-Bold').text('My Personal Work Schedule', 40, 65);
      doc.fillColor('#71717a');
      doc.fontSize(8.5).font('Helvetica').text(`Employee: ${schedule.employee.name} (${schedule.employee.email})`, 40, 78);
      
      doc.fillColor('#09090b');
      doc.fontSize(10).font('Helvetica-Bold').text(`Semaine de ${weekNo} - ${range}`, 40, 95);

      // Draw horizontal divider line
      doc.moveTo(40, 112).lineTo(555, 112).lineWidth(0.5).strokeColor('#e4e4e7').stroke();

      let currentY = 130;
      const weekdaysKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

      // Draw rows vertically
      weekdaysKeys.forEach((dayKey, idx) => {
        const day = schedule.days[dayKey] || { isOff: true, shifts: [] };
        const dateStr = getDayDateString(monday, idx);

        // Cell border outline
        doc.rect(40, currentY, 515, 42).lineWidth(0.5).strokeColor('#e4e4e7').stroke();

        // Left side: Day of week & date
        doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(9);
        doc.text(`${days[idx]} (${dateStr})`, 55, currentY + 16, { width: 130 });

        // Right side: Shift details
        const shiftX = 200;
        if (day.isOff) {
          doc.fillColor('#71717a').font('Helvetica').fontSize(8.5).text('Repos', shiftX, currentY + 16, { width: 330 });
        } else if (day.isLeave) {
          doc.fillColor('#b45309').font('Helvetica-Bold').fontSize(8.5).text(`Congé (${day.leaveHours}h)`, shiftX, currentY + 16, { width: 330 });
        } else if (day.shifts && day.shifts.length > 0) {
          let textY = currentY + 6;
          day.shifts.forEach((s, sIdx) => {
            // Display shift hours and tasks side-by-side [2]
            doc.fillColor('#09090b').font('Helvetica-Bold').fontSize(8).text(`${s.startTime} - ${s.endTime}`, shiftX, textY, { width: 80 });
            doc.fillColor('#71717a').font('Helvetica').fontSize(7.5).text(`${s.task} (Break: ${s.breakMinutes}m)`, shiftX + 90, textY + 0.5, { width: 230 });
            textY += 15;
          });
        }

        currentY += 47; // Push next row down
      });

      // Total Hours Footer Block [2]
      doc.rect(40, currentY + 10, 515, 30).fill('#18181b');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
      doc.text(`Total Scheduled Hours This Week: ${schedule.totalHours.toFixed(2)} hrs`, 55, currentY + 20);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

// 🛑 EXPORT THE NEW FUNCTION AT THE BOTTOM:
module.exports = { generateSchedulePDF, generatePersonalPDF, getWeekNumber, getWeekRangeString };
